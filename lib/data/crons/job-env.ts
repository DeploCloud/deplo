import "server-only";

import { eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { cronJobEnv as cronJobEnvTable } from "../../db/schema/control-plane/crons";
import { encryptSecret } from "../../crypto";
import { newId, nowIso } from "../../ids";

const MAX_ENV_VARS = 50;

export type EnvEntry = { key: string; value: string | null };

export function validateEnv(env: EnvEntry[]): EnvEntry[] {
  if (env.length > MAX_ENV_VARS) {
    throw new Error(`Keep the job to ${MAX_ENV_VARS} variables or fewer`);
  }
  const seen = new Set<string>();
  const out: EnvEntry[] = [];
  for (const e of env) {
    const key = e.key.trim();
    if (!key) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(
        `"${key}" is not a valid variable name - use letters, digits and underscores`,
      );
    }
    if (seen.has(key)) throw new Error(`"${key}" is listed twice`);
    seen.add(key);
    out.push({ key, value: e.value });
  }
  return out;
}

export async function writeEnv(jobId: string, env: EnvEntry[]): Promise<void> {
  await getDb().transaction(async (tx) => {
    const stored = new Map(
      (
        await tx
          .select({
            key: cronJobEnvTable.key,
            valueEnc: cronJobEnvTable.valueEnc,
          })
          .from(cronJobEnvTable)
          .where(eq(cronJobEnvTable.jobId, jobId))
      ).map((r) => [r.key, r.valueEnc]),
    );
    const rows = env.map((e) => {
      const valueEnc =
        e.value === null ? stored.get(e.key) : encryptSecret(e.value);
      if (valueEnc === undefined) throw new Error(`Give "${e.key}" a value`);
      return {
        id: newId("cronenv"),
        jobId,
        key: e.key,
        valueEnc,
        createdAt: nowIso(),
      };
    });
    await tx.delete(cronJobEnvTable).where(eq(cronJobEnvTable.jobId, jobId));
    if (rows.length > 0) await tx.insert(cronJobEnvTable).values(rows);
  });
}

export async function envKeysFor(
  jobIds: string[],
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (jobIds.length === 0) return out;
  const rows = await getDb()
    .select({ jobId: cronJobEnvTable.jobId, key: cronJobEnvTable.key })
    .from(cronJobEnvTable)
    .where(inArray(cronJobEnvTable.jobId, jobIds))
    .orderBy(cronJobEnvTable.key);
  for (const r of rows) {
    const list = out.get(r.jobId);
    if (list) list.push(r.key);
    else out.set(r.jobId, [r.key]);
  }
  return out;
}
