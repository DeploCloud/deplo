import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";

import { getDb } from "../db/client";
import { appBuild, apps } from "../db/schema/control-plane/apps";
import { databases } from "../db/schema/control-plane/databases";
import {
  imageInventories,
  imageInventoryPackages,
  kevCves,
  osvAffected,
  osvRanges,
  securityFindings,
  workloadImages,
} from "../db/schema/control-plane/security-updates";
import { recordActivity } from "../data/activity";
import { dispatchAlert } from "../notify/dispatch";
import { plural } from "../utils";
import { isDistroEcosystem, osvQueryFor, type OsvQuery } from "./ecosystem";
import {
  fixKind,
  inScope,
  isActionable,
  levelOf,
  type FixKind,
} from "./fix-kind";
import { countUpdates, unitKey } from "./group";
import { activeIgnores, ignoreKey } from "./ignored";
import {
  affectedFor,
  osvAffectedRows,
  osvQueryBatch,
  osvVuln,
  recordCve,
  recordSeverity,
  type OsvHit,
  type OsvRecord,
  type Severity,
} from "./osv";
import { affects, fixedFor, type AffectedRange } from "./versions";
import { candidateTarget } from "./workloads";

type Workload = typeof workloadImages.$inferSelect;
type Finding = typeof securityFindings.$inferInsert;
type CachedAffected = typeof osvAffected.$inferSelect & {
  ranges: AffectedRange[];
};

const FETCH_CONCURRENCY = 6;

const qkey = (q: OsvQuery) => `${q.ecosystem}\0${q.name}\0${q.version}`;
type FindingKey = Pick<
  Finding,
  | "serverId"
  | "workloadId"
  | "service"
  | "vulnId"
  | "ecosystem"
  | "packageName"
  | "installedVersion"
>;
const fkey = (f: FindingKey) =>
  `${f.vulnId}\0${f.ecosystem}\0${f.packageName}\0${f.installedVersion}`;
const findingPk = (f: FindingKey) =>
  and(
    eq(securityFindings.serverId, f.serverId),
    eq(securityFindings.workloadId, f.workloadId),
    eq(securityFindings.service, f.service),
    eq(securityFindings.vulnId, f.vulnId),
    eq(securityFindings.ecosystem, f.ecosystem),
    eq(securityFindings.packageName, f.packageName),
    eq(securityFindings.installedVersion, f.installedVersion),
  );

function chunks<T>(xs: T[], n = 1000): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

async function pool<T>(xs: T[], n: number, run: (x: T) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, xs.length) }, async () => {
      while (next < xs.length) await run(xs[next++]);
    }),
  );
}

// Re-read the OSV records whose `modified` moved; returns the ids that could not be read.
async function refreshVulnCache(
  hits: Map<string, string>,
  now: string,
): Promise<Set<string>> {
  const db = getDb();
  const ids = [...hits.keys()];
  const known = new Map<string, string>();
  for (const part of chunks(ids)) {
    const rows = await db
      .selectDistinct({
        vulnId: osvAffected.vulnId,
        modified: osvAffected.modified,
      })
      .from(osvAffected)
      .where(inArray(osvAffected.vulnId, part));
    for (const r of rows) known.set(r.vulnId, r.modified);
  }
  const stale = ids.filter((id) => known.get(id) !== hits.get(id));
  const failed = new Set<string>();
  const cveSeverity = new Map<string, Promise<OsvRecord | null>>();
  await pool(stale, FETCH_CONCURRENCY, async (id) => {
    try {
      const rec = await osvVuln(id);
      let rows = rec ? osvAffectedRows(rec) : [];
      const cve = rec ? recordCve(rec) : null;
      if (rec && cve && cve !== rec.id && !recordSeverity(rec).severity) {
        if (!cveSeverity.has(cve))
          cveSeverity.set(
            cve,
            osvVuln(cve).catch(() => null),
          );
        const cveRec = await cveSeverity.get(cve);
        if (cveRec) rows = osvAffectedRows(rec, recordSeverity(cveRec));
      }
      await db.transaction(async (tx) => {
        await tx.delete(osvAffected).where(eq(osvAffected.vulnId, id));
        if (rows.length)
          await tx.insert(osvAffected).values(
            rows.map((r) => ({
              vulnId: r.vulnId,
              ecosystem: r.ecosystem,
              name: r.name,
              cve: r.cve,
              severity: r.severity,
              cvssTenths: r.cvssTenths,
              summary: r.summary,
              modified: r.modified,
              fetchedAt: now,
            })),
          );
        const ranges = rows.flatMap((r) =>
          r.ranges.map((g, seq) => ({
            vulnId: r.vulnId,
            ecosystem: r.ecosystem,
            name: r.name,
            seq,
            ...g,
          })),
        );
        for (const part of chunks(ranges))
          await tx.insert(osvRanges).values(part);
      });
    } catch {
      failed.add(id);
    }
  });
  return failed;
}

async function cachedAffected(
  ids: string[],
): Promise<Map<string, CachedAffected[]>> {
  const out = new Map<string, CachedAffected[]>();
  for (const part of chunks(ids)) {
    const db = getDb();
    const [rows, ranges] = await Promise.all([
      db.select().from(osvAffected).where(inArray(osvAffected.vulnId, part)),
      db
        .select()
        .from(osvRanges)
        .where(inArray(osvRanges.vulnId, part))
        .orderBy(osvRanges.seq),
    ]);
    const byPkg = new Map<string, AffectedRange[]>();
    for (const g of ranges) {
      const k = `${g.vulnId}\0${g.ecosystem}\0${g.name}`;
      byPkg.set(k, [
        ...(byPkg.get(k) ?? []),
        {
          introduced: g.introduced,
          fixed: g.fixed,
          lastAffected: g.lastAffected,
        },
      ]);
    }
    for (const r of rows)
      out.set(r.vulnId, [
        ...(out.get(r.vulnId) ?? []),
        {
          ...r,
          ranges: byPkg.get(`${r.vulnId}\0${r.ecosystem}\0${r.name}`) ?? [],
        },
      ]);
  }
  return out;
}

interface Subject {
  kind: "app" | "database";
  id: string;
  teamId: string;
  found: number;
  fixed: number;
}

export interface MatchResult {
  workloads: number;
  findings: number;
}

// Match the package lists of the workloads in scope against OSV and store their open findings.
// Throws OsvUnavailableError when OSV cannot be queried: nothing is changed then.
export async function matchWorkloads(
  scope: "full" | "light",
  now: Date,
): Promise<MatchResult> {
  const db = getDb();
  const stamp = now.toISOString();
  const rows = await db
    .select({
      wi: workloadImages,
      inv: imageInventories,
      builder: appBuild.buildMethod,
    })
    .from(workloadImages)
    .innerJoin(
      imageInventories,
      eq(imageInventories.imageId, workloadImages.imageId),
    )
    .leftJoin(appBuild, eq(appBuild.appId, workloadImages.appId))
    .where(scope === "full" ? undefined : isNull(workloadImages.checkedAt));
  if (rows.length === 0) return { workloads: 0, findings: 0 };

  const okImages = [
    ...new Set(
      rows.filter((r) => r.inv.status === "ok").map((r) => r.inv.imageId),
    ),
  ];
  const packages = new Map<
    string,
    (typeof imageInventoryPackages.$inferSelect)[]
  >();
  for (const part of chunks(okImages, 200)) {
    const pk = await db
      .select()
      .from(imageInventoryPackages)
      .where(inArray(imageInventoryPackages.imageId, part));
    for (const p of pk)
      packages.set(p.imageId, [...(packages.get(p.imageId) ?? []), p]);
  }
  const distro = new Map(
    rows.map((r) => [
      r.inv.imageId,
      { id: r.inv.distroId, version: r.inv.distroVersion },
    ]),
  );
  const queries = new Map<string, OsvQuery>();
  const perImage = new Map<
    string,
    { pkg: typeof imageInventoryPackages.$inferSelect; q: OsvQuery }[]
  >();
  for (const [imageId, pkgs] of packages) {
    const list: {
      pkg: typeof imageInventoryPackages.$inferSelect;
      q: OsvQuery;
    }[] = [];
    for (const pkg of pkgs) {
      const q = osvQueryFor(
        pkg.purl,
        distro.get(imageId) ?? { id: "", version: "" },
      );
      // A system package is never the team's (ADR-0038): OSV never hears of it.
      if (!q || isDistroEcosystem(q.ecosystem)) continue;
      queries.set(qkey(q), q);
      list.push({ pkg, q });
    }
    perImage.set(imageId, list);
  }

  const candidates = await candidatePackages(rows.map((r) => r.wi));

  const qs = [...queries.values()];
  const results = await osvQueryBatch(qs);
  const hitsByQuery = new Map<string, OsvHit[]>();
  const hitModified = new Map<string, string>();
  qs.forEach((q, i) => {
    hitsByQuery.set(qkey(q), results[i]);
    for (const h of results[i]) hitModified.set(h.id, h.modified);
  });
  const failedVulns = await refreshVulnCache(hitModified, stamp);
  const affected = await cachedAffected([...hitModified.keys()]);
  const kev = new Set((await db.select().from(kevCves)).map((k) => k.cveId));

  const subjects = new Map<string, Subject>();
  let total = 0;
  for (const { wi, inv, builder } of rows) {
    const wanted =
      inv.status === "ok"
        ? findingsFor(
            wi,
            inv,
            builder,
            perImage.get(inv.imageId) ?? [],
            hitsByQuery,
            affected,
            kev,
            stamp,
            candidates.get(`${wi.serverId}\0${wi.workloadId}\0${wi.service}`) ??
              null,
          )
        : [];
    const diff = await persistFindings(
      wi,
      wanted,
      failedVulns,
      inv.status === "ok",
      stamp,
    );
    total += wanted.length;
    if (wi.kind === "preview") continue;
    const id = wi.kind === "database" ? wi.databaseId : wi.appId;
    if (!id) continue;
    const key = `${wi.kind}:${id}`;
    const s = subjects.get(key) ?? {
      kind: wi.kind as Subject["kind"],
      id,
      teamId: wi.teamId,
      found: 0,
      fixed: 0,
    };
    s.found += diff.found;
    s.fixed += diff.fixed;
    subjects.set(key, s);
  }

  await recordSubjectActivity([...subjects.values()]);
  await alertNewFindings(now);
  return { workloads: rows.length, findings: total };
}

function findingsFor(
  wi: Workload,
  inv: typeof imageInventories.$inferSelect,
  builder: string | null,
  pkgs: { pkg: typeof imageInventoryPackages.$inferSelect; q: OsvQuery }[],
  hitsByQuery: Map<string, OsvHit[]>,
  affected: Map<string, CachedAffected[]>,
  kev: ReadonlySet<string>,
  stamp: string,
  // The newer build's versions per package, once read; null until then.
  candidate: Map<string, string[]> | null,
): Finding[] {
  // One finding per package and CVE: distros publish the same flaw under several ids.
  const best = new Map<string, { f: Finding; actionable: boolean }>();
  for (const { pkg, q } of pkgs) {
    for (const hit of hitsByQuery.get(qkey(q)) ?? []) {
      const a = affectedFor(affected.get(hit.id) ?? [], q.ecosystem, q.name);
      if (!a) continue;
      const level = levelOf(a.severity as Severity | null, a.cve, kev);
      if (!level) continue;
      const fixedVersion = fixedFor(a.ranges, q.version);
      const later = candidate?.get(`${q.ecosystem}\0${q.name}`) ?? [];
      const verdict = !candidate
        ? "unread"
        : later.includes(q.version) || later.some((v) => affects(a.ranges, v))
          ? "vulnerable"
          : "fixed";
      const fix = fixKind({
        imageRef: wi.imageRef,
        builder,
        ecosystem: q.ecosystem,
        location: pkg.location,
        workingDir: inv.workingDir,
        fixedVersion,
        repoDigest: wi.repoDigest,
        registryStatus: wi.registryStatus,
        registryDigest: wi.registryDigest,
        newerTag: wi.newerTag,
        candidate: verdict,
      });
      const f = {
        serverId: wi.serverId,
        workloadId: wi.workloadId,
        service: wi.service,
        vulnId: hit.id,
        ecosystem: q.ecosystem,
        packageName: q.name,
        installedVersion: q.version,
        fixedVersion,
        location: pkg.location,
        level,
        fix,
        firstSeenAt: stamp,
      };
      if (!inScope(f)) continue;
      const entry = { f, actionable: isActionable(f) };
      const key = `${q.ecosystem}\0${q.name}\0${q.version}\0${a.cve ?? hit.id}`;
      const prev = best.get(key);
      if (!prev || better(entry, prev)) best.set(key, entry);
    }
  }
  return [...best.values()].map((e) => e.f);
}

const RANK: Record<FixKind, number> = {
  code: 0,
  rebuild: 1,
  update: 2,
  newer_tag: 3,
  upstream: 4,
  unverified: 5,
  deplo: 6,
  none: 7,
};

// The packages of the newer build read for each workload whose newer build is still that one.
async function candidatePackages(
  workloads: Workload[],
): Promise<Map<string, Map<string, string[]>>> {
  const byImage = new Map<string, string[]>();
  for (const w of workloads) {
    const target = candidateTarget(w);
    if (!target || w.candidateRef !== target || w.candidateStatus !== "ok")
      continue;
    if (!w.candidateImageId) continue;
    const key = `${w.serverId}\0${w.workloadId}\0${w.service}`;
    byImage.set(w.candidateImageId, [
      ...(byImage.get(w.candidateImageId) ?? []),
      key,
    ]);
  }
  const out = new Map<string, Map<string, string[]>>();
  if (byImage.size === 0) return out;
  const pkgs = await getDb()
    .select()
    .from(imageInventoryPackages)
    .where(inArray(imageInventoryPackages.imageId, [...byImage.keys()]));
  const versions = new Map<string, Map<string, string[]>>();
  for (const p of pkgs) {
    const q = osvQueryFor(p.purl, { id: "", version: "" });
    if (!q) continue;
    const m = versions.get(p.imageId) ?? new Map<string, string[]>();
    const k = `${q.ecosystem}\0${q.name}`;
    m.set(k, [...(m.get(k) ?? []), q.version]);
    versions.set(p.imageId, m);
  }
  for (const [imageId, keys] of byImage)
    for (const key of keys) out.set(key, versions.get(imageId) ?? new Map());
  return out;
}
type Ranked = { f: Finding; actionable: boolean };
function better(a: Ranked, b: Ranked) {
  if (a.actionable !== b.actionable) return a.actionable;
  const r = RANK[a.f.fix as FixKind] - RANK[b.f.fix as FixKind];
  return r !== 0 ? r < 0 : a.f.vulnId < b.f.vulnId;
}

async function persistFindings(
  wi: Workload,
  wanted: Finding[],
  failedVulns: ReadonlySet<string>,
  readable: boolean,
  stamp: string,
): Promise<{ found: number; fixed: number }> {
  const actionable = (f: Finding) =>
    isActionable({ ...f, location: f.location ?? "" });
  // Counted per update: one move closes every advisory on a package or an image.
  // A row out of today's scope was never counted, so dropping it is not a fix.
  const before = new Set<string>();
  const after = new Set<string>();
  const remaining = new Set<string>();
  await getDb().transaction(async (tx) => {
    const where = and(
      eq(securityFindings.serverId, wi.serverId),
      eq(securityFindings.workloadId, wi.workloadId),
      eq(securityFindings.service, wi.service),
    );
    const existing = new Map(
      (await tx.select().from(securityFindings).where(where)).map((f) => [
        fkey(f),
        f,
      ]),
    );
    const next = new Map(wanted.map((f) => [fkey(f), f]));
    // One alert per update: a new advisory on one already alerted stays quiet.
    const alerted = new Map<string, string>();
    for (const f of existing.values()) {
      if (actionable(f)) before.add(unitKey(f));
      if (f.alertedAt) alerted.set(unitKey(f), f.alertedAt);
    }
    for (const [k, f] of next) {
      remaining.add(unitKey(f));
      if (actionable(f)) after.add(unitKey(f));
      const old = existing.get(k);
      if (!old) {
        await tx
          .insert(securityFindings)
          .values({ ...f, alertedAt: alerted.get(unitKey(f)) ?? null });
        continue;
      }
      if (
        old.level !== f.level ||
        old.fix !== f.fix ||
        old.fixedVersion !== f.fixedVersion ||
        old.location !== f.location
      )
        await tx
          .update(securityFindings)
          .set({
            level: f.level,
            fix: f.fix,
            fixedVersion: f.fixedVersion,
            location: f.location,
          })
          .where(findingPk(f));
    }
    for (const [k, old] of existing) {
      if (next.has(k)) continue;
      if (failedVulns.has(old.vulnId) && inScope(old)) {
        remaining.add(unitKey(old));
        if (actionable(old)) after.add(unitKey(old));
        continue;
      }
      await tx.delete(securityFindings).where(findingPk(old));
    }
    await tx
      .update(workloadImages)
      .set({ checkedAt: stamp })
      .where(
        and(
          eq(workloadImages.serverId, wi.serverId),
          eq(workloadImages.workloadId, wi.workloadId),
          eq(workloadImages.service, wi.service),
        ),
      );
  });
  const found = [...after].filter((k) => !before.has(k)).length;
  // An image Deplo could not read says nothing about whether a flaw is gone.
  const fixed = readable
    ? [...before].filter((k) => !remaining.has(k)).length
    : 0;
  return { found, fixed };
}

async function subjectNames(subjects: { kind: string; id: string }[]) {
  const appIds = subjects.filter((s) => s.kind === "app").map((s) => s.id);
  const dbIds = subjects.filter((s) => s.kind === "database").map((s) => s.id);
  const db = getDb();
  const [a, d] = await Promise.all([
    appIds.length
      ? db
          .select({ id: apps.id, name: apps.name, slug: apps.slug })
          .from(apps)
          .where(inArray(apps.id, appIds))
      : [],
    dbIds.length
      ? db
          .select({ id: databases.id, name: databases.name })
          .from(databases)
          .where(inArray(databases.id, dbIds))
      : [],
  ]);
  const out = new Map<string, { name: string; path: string }>();
  for (const r of a)
    out.set(`app:${r.id}`, { name: r.name, path: `/apps/${r.slug}` });
  for (const r of d)
    out.set(`database:${r.id}`, {
      name: r.name,
      path: `/storage/databases/${r.id}`,
    });
  return out;
}

async function recordSubjectActivity(subjects: Subject[]): Promise<void> {
  const active = subjects.filter((s) => s.found || s.fixed);
  if (active.length === 0) return;
  const names = await subjectNames(active);
  for (const s of active) {
    const name = names.get(`${s.kind}:${s.id}`)?.name;
    if (!name) continue;
    const appId = s.kind === "app" ? s.id : null;
    const databaseId = s.kind === "database" ? s.id : null;
    if (s.found)
      await recordActivity(
        "security_update",
        `Found ${plural(s.found, "security update", "security updates")} in ${name}`,
        "Deplo",
        appId,
        s.teamId,
        null,
        databaseId,
      );
    if (s.fixed)
      await recordActivity(
        "security_update",
        `${plural(s.fixed, "security update", "security updates")} in ${name} ${s.fixed === 1 ? "is" : "are"} fixed`,
        "Deplo",
        appId,
        s.teamId,
        null,
        databaseId,
      );
  }
}

// One alert per app or database for qualifying findings it never alerted on; running workloads only.
async function alertNewFindings(now: Date): Promise<void> {
  const db = getDb();
  const rows = await db
    .select({
      f: securityFindings,
      kind: workloadImages.kind,
      teamId: workloadImages.teamId,
      appId: workloadImages.appId,
      databaseId: workloadImages.databaseId,
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
        isNull(securityFindings.alertedAt),
        eq(workloadImages.running, true),
        inArray(workloadImages.kind, ["app", "database"]),
      ),
    );
  const ignores = await activeIgnores(
    {
      appIds: rows
        .filter((r) => r.kind === "app")
        .flatMap((r) => r.appId ?? []),
      databaseIds: rows
        .filter((r) => r.kind === "database")
        .flatMap((r) => r.databaseId ?? []),
    },
    now,
  );
  const due = new Map<
    string,
    {
      kind: string;
      id: string;
      teamId: string;
      findings: (typeof rows)[number]["f"][];
    }
  >();
  for (const r of rows) {
    if (!isActionable(r.f)) continue;
    const id = r.kind === "database" ? r.databaseId : r.appId;
    if (!id || ignores.has(ignoreKey(id, r.f.vulnId))) continue;
    const key = `${r.kind}:${id}`;
    const e = due.get(key) ?? {
      kind: r.kind,
      id,
      teamId: r.teamId,
      findings: [],
    };
    e.findings.push(r.f);
    due.set(key, e);
  }
  if (due.size === 0) return;
  const names = await subjectNames([...due.values()]);
  const stamp = now.toISOString();
  for (const [key, e] of due) {
    const n = names.get(key);
    if (n) {
      const { count, exploited } = countUpdates(
        e.findings.map((f) => ({ ...f, actionable: true })),
      );
      dispatchAlert({
        teamId: e.teamId,
        key: "security_update_available",
        title: `Security ${count === 1 ? "update" : "updates"} for ${n.name}`,
        body:
          `${plural(count, "security update", "security updates")} to apply` +
          (exploited ? `, ${exploited} already used in attacks.` : "."),
        path: n.path,
        appId: e.kind === "app" ? e.id : null,
      });
    }
    for (const f of e.findings)
      await db
        .update(securityFindings)
        .set({ alertedAt: stamp })
        .where(findingPk(f));
  }
}

// Replace CISA's known-exploited list in one go.
export async function storeKev(ids: string[]): Promise<void> {
  await getDb().transaction(async (tx) => {
    await tx.delete(kevCves);
    for (const part of chunks([...new Set(ids)], 1000))
      await tx.insert(kevCves).values(part.map((cveId) => ({ cveId })));
  });
}
