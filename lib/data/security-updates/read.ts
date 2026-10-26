import "server-only";

import { cache } from "@/lib/request-cache";
import { and, eq, inArray, isNotNull, max } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps } from "../../db/schema/control-plane/apps";
import { deployments } from "../../db/schema/control-plane/deployments";
import {
  epssScores,
  imageInventories,
  osvAffected,
  securityFindings,
  securityPullRequests,
  workloadImages,
} from "../../db/schema/control-plane/security-updates";
import { requireActiveTeamId } from "../../membership";
import { affectedFor } from "../../security-updates/osv";
import {
  inScope,
  isActionable,
  type FixKind,
  type Level,
} from "../../security-updates/fix-kind";
import {
  countUpdates,
  groupUpdates,
  type Groupable,
  type UpdateGroup,
} from "../../security-updates/group";
import { activeIgnores, ignoreKey } from "../../security-updates/ignored";
import { securityState } from "../../security-updates/state";
import { getDatabase } from "../databases/rows";
import { hasAppCapability } from "../node-access";

export interface SecurityUpdate {
  vulnId: string;
  // Set aside by the team until ignoredUntil: listed, never counted or alerted.
  ignored: boolean;
  ignoredUntil: string | null;
  ignoreReason: string | null;
  ignoredBy: string | null;
  cve: string | null;
  level: Level;
  cvss: number | null;
  summary: string;
  ecosystem: string;
  packageName: string;
  installedVersion: string;
  fixedVersion: string | null;
  fix: FixKind;
  // Critical or attacked, in scope: what the badge counts and alerts fire for.
  counted: boolean;
  // Older name for counted, kept for API clients.
  actionable: boolean;
  // FIRST's chance of exploitation in the next 30 days, 0 to 1; null when unscored.
  epss: number | null;
  service: string;
  // The image it was found in: an image's update moves it whole.
  imageRef: string;
  // Who pulls the package in, parent first up to the app's own dependency; [] when direct.
  via: string[];
  osvUrl: string;
}

export interface SecurityUpdates {
  // The oldest check behind this answer; null until every image was matched once.
  checkedAt: string | null;
  // A deploy went live after the last check: its image is being read, the old one's findings hidden.
  checking: boolean;
  // Statuses of images Deplo could not read ("too_large", "low_disk", ...).
  unreadable: string[];
  count: number;
  exploited: number;
  newerTag: string | null;
  updates: SecurityUpdate[];
  // One per package of the app's, or per image, with its advisories: what the dashboard lists.
  groups: SecurityGroup[];
  // A GitHub app, and the caller may open a pull request with a dependency's fix.
  canOpenPullRequests: boolean;
}

export interface SecurityGroup extends UpdateGroup<SecurityUpdate> {
  // The pull request Deplo opened for this package's fixed version.
  pullRequest: { number: number; url: string } | null;
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

// When each app last went live; a workload listed before that runs an image not read yet.
async function deployedAt(appIds: string[]): Promise<Map<string, string>> {
  if (appIds.length === 0) return new Map();
  const rows = await getDb()
    .select({ appId: deployments.appId, at: max(deployments.readyAt) })
    .from(deployments)
    .where(
      and(
        inArray(deployments.appId, appIds),
        eq(deployments.status, "ready"),
        isNotNull(deployments.readyAt),
      ),
    )
    .groupBy(deployments.appId);
  return new Map(rows.flatMap((r) => (r.at ? [[r.appId, r.at]] : [])));
}

const checking = (
  wi: { checkedAt: string | null; seenAt: string },
  liveSince: string | undefined,
) =>
  !wi.checkedAt || (!!liveSince && new Date(liveSince) > new Date(wi.seenAt));

const workloadKey = (w: {
  serverId: string;
  workloadId: string;
  service: string;
}) => `${w.serverId}\0${w.workloadId}\0${w.service}`;

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
        .select({ f: securityFindings, imageRef: workloadImages.imageRef })
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

  const subjectId = s.kind === "app" ? s.appId : s.databaseId;
  const liveSince =
    s.kind === "app" ? (await deployedAt([s.appId])).get(s.appId) : undefined;
  const stale = new Set(
    rows.filter((r) => checking(r.wi, liveSince)).map((r) => workloadKey(r.wi)),
  );
  const ignores = await activeIgnores(
    s.kind === "app" ? { appIds: [s.appId] } : { databaseIds: [s.databaseId] },
  );
  const cves = [...new Set(osv.flatMap((o) => (o.cve ? [o.cve] : [])))];
  const epss = new Map(
    (cves.length
      ? await db
          .select()
          .from(epssScores)
          .where(inArray(epssScores.cveId, cves))
      : []
    ).map((e) => [e.cveId, e.scoreBp / 10_000]),
  );
  const updates = findings
    .filter(({ f }) => inScope(f) && !stale.has(workloadKey(f)))
    .map(({ f, imageRef }): SecurityUpdate => {
      const ig = ignores.get(ignoreKey(subjectId, f.vulnId));
      const a = affectedFor(
        osv.filter((o) => o.vulnId === f.vulnId),
        f.ecosystem,
        f.packageName,
      );
      const level = f.level as Level;
      const fix = f.fix as FixKind;
      return {
        vulnId: f.vulnId,
        ignored: Boolean(ig),
        ignoredUntil: ig?.expiresAt ?? null,
        ignoreReason: ig ? ig.reason : null,
        ignoredBy: ig?.createdBy ?? null,
        cve: a?.cve ?? null,
        level,
        cvss: a?.cvssTenths != null ? a.cvssTenths / 10 : null,
        summary: a?.summary ?? "",
        ecosystem: f.ecosystem,
        packageName: f.packageName,
        installedVersion: f.installedVersion,
        fixedVersion: f.fixedVersion,
        fix,
        counted: isActionable(f),
        actionable: isActionable(f),
        epss: a?.cve ? (epss.get(a.cve) ?? null) : null,
        service: f.service,
        imageRef,
        via: f.via ? f.via.split("\t") : [],
        osvUrl: `https://osv.dev/vulnerability/${encodeURIComponent(f.vulnId)}`,
      };
    });
  updates.sort(
    (x, y) =>
      Number(y.actionable) - Number(x.actionable) ||
      LEVEL_ORDER[x.level] - LEVEL_ORDER[y.level] ||
      x.packageName.localeCompare(y.packageName),
  );
  const counted = countUpdates(updates.filter((u) => !u.ignored));
  const prs = new Map(
    (s.kind === "app"
      ? await db
          .select()
          .from(securityPullRequests)
          .where(
            and(
              eq(securityPullRequests.teamId, teamId),
              eq(securityPullRequests.appId, s.appId),
            ),
          )
      : []
    ).map((r) => [
      `${r.packageName}\0${r.version}`,
      { number: r.number, url: r.url },
    ]),
  );
  const checked = rows.map((r) => r.wi.checkedAt);
  return {
    checkedAt:
      checked.length && checked.every(Boolean)
        ? (checked as string[]).sort()[0]
        : null,
    checking: stale.size > 0,
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
    groups: groupUpdates(updates).map((g) => ({
      ...g,
      pullRequest:
        prs.get(`${g.items[0].packageName}\0${g.fixedVersion}`) ?? null,
    })),
    canOpenPullRequests: false,
  };
}

async function canOpenPullRequests(appId: string): Promise<boolean> {
  const [app] = await getDb()
    .select({ provider: apps.repoProvider, install: apps.repoInstallationId })
    .from(apps)
    .where(eq(apps.id, appId))
    .limit(1);
  return (
    app?.provider === "github" &&
    !!app.install &&
    (await hasAppCapability(appId, "open_security_prs"))
  );
}

// An app's security updates; null when the app is out of reach or the instance switch is off.
export const appSecurityUpdates = cache(async function appSecurityUpdates(
  appId: string,
): Promise<SecurityUpdates | null> {
  const teamId = await requireActiveTeamId();
  if (!(await securityState()).enabled) return null;
  if (!(await hasAppCapability(appId, "view"))) return null;
  return {
    ...(await subjectUpdates(teamId, { kind: "app", appId })),
    canOpenPullRequests: await canOpenPullRequests(appId),
  };
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
      location: securityFindings.location,
      vulnId: securityFindings.vulnId,
      checkedAt: workloadImages.checkedAt,
      seenAt: workloadImages.seenAt,
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
  const ignores =
    kind === "preview"
      ? new Map()
      : await activeIgnores(
          kind === "app" ? { appIds: ids } : { databaseIds: ids },
        );
  const live = kind === "app" ? await deployedAt(ids) : new Map();
  const byId = new Map<string, ((typeof rows)[number] & Groupable)[]>();
  for (const r of rows)
    if (
      r.id &&
      inScope(r) &&
      !checking(r, live.get(r.id)) &&
      !ignores.has(ignoreKey(r.id, r.vulnId))
    )
      byId.set(r.id, [
        ...(byId.get(r.id) ?? []),
        { ...r, actionable: isActionable(r) },
      ]);
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
