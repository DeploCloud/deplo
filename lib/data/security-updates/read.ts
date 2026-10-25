import "server-only";

import { cache } from "@/lib/request-cache";
import { and, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  imageInventories,
  osvAffected,
  securityFindings,
  workloadImages,
} from "../../db/schema/control-plane/security-updates";
import { requireActiveTeamId } from "../../membership";
import { affectedFor } from "../../security-updates/osv";
import {
  isActionable,
  type FixKind,
  type Level,
} from "../../security-updates/fix-kind";
import { countUpdates } from "../../security-updates/group";
import { securityState } from "../../security-updates/state";
import { getDatabase } from "../databases/rows";
import { hasAppCapability } from "../node-access";

export interface SecurityUpdate {
  vulnId: string;
  cve: string | null;
  level: Level;
  cvss: number | null;
  summary: string;
  ecosystem: string;
  packageName: string;
  installedVersion: string;
  fixedVersion: string | null;
  fix: FixKind;
  actionable: boolean;
  service: string;
  osvUrl: string;
}

export interface SecurityUpdates {
  // The oldest check behind this answer; null until every image was matched once.
  checkedAt: string | null;
  // Statuses of images Deplo could not read ("too_large", "low_disk", ...).
  unreadable: string[];
  count: number;
  exploited: number;
  newerTag: string | null;
  updates: SecurityUpdate[];
}

export interface SecurityCount {
  count: number;
  exploited: number;
}

const LEVEL_ORDER: Record<Level, number> = {
  exploited: 0,
  critical: 1,
  high: 2,
};

type Subject =
  { kind: "app"; appId: string } | { kind: "database"; databaseId: string };

async function subjectUpdates(
  teamId: string,
  s: Subject,
): Promise<SecurityUpdates> {
  const db = getDb();
  const owner =
    s.kind === "app"
      ? and(eq(workloadImages.kind, "app"), eq(workloadImages.appId, s.appId))
      : and(
          eq(workloadImages.kind, "database"),
          eq(workloadImages.databaseId, s.databaseId),
        );
  const rows = await db
    .select({ wi: workloadImages, status: imageInventories.status })
    .from(workloadImages)
    .leftJoin(
      imageInventories,
      eq(imageInventories.imageId, workloadImages.imageId),
    )
    .where(and(eq(workloadImages.teamId, teamId), owner));
  const findings = rows.length
    ? await db
        .select({ f: securityFindings })
        .from(securityFindings)
        .innerJoin(
          workloadImages,
          and(
            eq(workloadImages.serverId, securityFindings.serverId),
            eq(workloadImages.workloadId, securityFindings.workloadId),
            eq(workloadImages.service, securityFindings.service),
          ),
        )
        .where(and(eq(workloadImages.teamId, teamId), owner))
    : [];
  const vulnIds = [...new Set(findings.map((r) => r.f.vulnId))];
  const osv = vulnIds.length
    ? await db
        .select()
        .from(osvAffected)
        .where(inArray(osvAffected.vulnId, vulnIds))
    : [];

  const updates = findings.map(({ f }): SecurityUpdate => {
    const a = affectedFor(
      osv.filter((o) => o.vulnId === f.vulnId),
      f.ecosystem,
      f.packageName,
    );
    const level = f.level as Level;
    const fix = f.fix as FixKind;
    return {
      vulnId: f.vulnId,
      cve: a?.cve ?? null,
      level,
      cvss: a?.cvssTenths != null ? a.cvssTenths / 10 : null,
      summary: a?.summary ?? "",
      ecosystem: f.ecosystem,
      packageName: f.packageName,
      installedVersion: f.installedVersion,
      fixedVersion: f.fixedVersion,
      fix,
      actionable: isActionable(fix, level),
      service: f.service,
      osvUrl: `https://osv.dev/vulnerability/${encodeURIComponent(f.vulnId)}`,
    };
  });
  updates.sort(
    (x, y) =>
      Number(y.actionable) - Number(x.actionable) ||
      LEVEL_ORDER[x.level] - LEVEL_ORDER[y.level] ||
      x.packageName.localeCompare(y.packageName),
  );
  const counted = countUpdates(updates);
  const checked = rows.map((r) => r.wi.checkedAt);
  return {
    checkedAt:
      checked.length && checked.every(Boolean)
        ? (checked as string[]).sort()[0]
        : null,
    unreadable: [
      ...new Set(
        rows
          .map((r) => r.status)
          .filter((st): st is string => !!st && st !== "ok"),
      ),
    ],
    count: counted.count,
    exploited: counted.exploited,
    newerTag: rows.find((r) => r.wi.newerTag)?.wi.newerTag ?? null,
    updates,
  };
}

// An app's security updates; null when the app is out of reach or the instance switch is off.
export const appSecurityUpdates = cache(async function appSecurityUpdates(
  appId: string,
): Promise<SecurityUpdates | null> {
  const teamId = await requireActiveTeamId();
  if (!(await securityState()).enabled) return null;
  if (!(await hasAppCapability(appId, "view"))) return null;
  return subjectUpdates(teamId, { kind: "app", appId });
});

export const databaseSecurityUpdates = cache(
  async function databaseSecurityUpdates(
    databaseId: string,
  ): Promise<SecurityUpdates | null> {
    const teamId = await requireActiveTeamId();
    if (!(await securityState()).enabled) return null;
    if (!(await getDatabase(databaseId))) return null;
    return subjectUpdates(teamId, { kind: "database", databaseId });
  },
);

// What the badge counts for each id the caller already holds (apps or databases of the active team).
async function countsBy(
  kind: "app" | "database" | "preview",
  ids: string[],
): Promise<Map<string, SecurityCount>> {
  const out = new Map<string, SecurityCount>();
  if (ids.length === 0) return out;
  const teamId = await requireActiveTeamId();
  if (!(await securityState()).enabled) return out;
  const idCol =
    kind === "app"
      ? workloadImages.appId
      : kind === "preview"
        ? workloadImages.previewId
        : workloadImages.databaseId;
  const rows = await getDb()
    .select({
      id: idCol,
      service: securityFindings.service,
      ecosystem: securityFindings.ecosystem,
      packageName: securityFindings.packageName,
      installedVersion: securityFindings.installedVersion,
      level: securityFindings.level,
      fix: securityFindings.fix,
      fixedVersion: securityFindings.fixedVersion,
    })
    .from(securityFindings)
    .innerJoin(
      workloadImages,
      and(
        eq(workloadImages.serverId, securityFindings.serverId),
        eq(workloadImages.workloadId, securityFindings.workloadId),
        eq(workloadImages.service, securityFindings.service),
      ),
    )
    .where(
      and(
        eq(workloadImages.teamId, teamId),
        eq(workloadImages.kind, kind),
        inArray(idCol, ids),
      ),
    );
  const byId = new Map<string, typeof rows>();
  for (const r of rows)
    if (r.id) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
  for (const [id, list] of byId) {
    const c = countUpdates(list);
    if (c.count) out.set(id, c);
  }
  return out;
}

export const appSecurityCounts = cache((appIds: string[]) =>
  countsBy("app", appIds),
);
export const databaseSecurityCounts = cache((ids: string[]) =>
  countsBy("database", ids),
);
export const previewSecurityCounts = cache((ids: string[]) =>
  countsBy("preview", ids),
);
