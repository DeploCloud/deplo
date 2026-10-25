import "server-only";

import { and, gt, inArray, or } from "drizzle-orm";

import { getDb } from "../db/client";
import { securityIgnores } from "../db/schema/control-plane/security-updates";

export type IgnoreRow = typeof securityIgnores.$inferSelect;

export const ignoreKey = (subjectId: string, vulnId: string) =>
  `${subjectId}\0${vulnId}`;

// The ignores still in force for these apps and databases; an expired one simply stops counting.
export async function activeIgnores(
  subjects: { appIds?: string[]; databaseIds?: string[] },
  now: Date = new Date(),
): Promise<Map<string, IgnoreRow>> {
  const appIds = subjects.appIds ?? [];
  const databaseIds = subjects.databaseIds ?? [];
  const out = new Map<string, IgnoreRow>();
  if (appIds.length === 0 && databaseIds.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(securityIgnores)
    .where(
      and(
        gt(securityIgnores.expiresAt, now.toISOString()),
        or(
          appIds.length ? inArray(securityIgnores.appId, appIds) : undefined,
          databaseIds.length
            ? inArray(securityIgnores.databaseId, databaseIds)
            : undefined,
        ),
      ),
    );
  for (const r of rows) {
    const subject = r.appId ?? r.databaseId;
    if (subject) out.set(ignoreKey(subject, r.vulnId), r);
  }
  return out;
}
