import "server-only";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import type { DbTx } from "../db/client";
import {
  deployments,
  domains,
  domainMiddlewares,
  envVars,
  envVarTargets,
  apps,
  appBuild,
  appBuildMethodSettings,
  appDev,
  appMounts,
  appVolumes,
} from "../db/schema/control-plane";
import type { Deployment, Domain, EnvVar, App } from "../types";
import {
  assembleDeployment,
  assembleDomain,
  assembleEnvVar,
  assembleApp,
  domainToRow,
  domainMiddlewaresToRows,
  envVarToRow,
  envVarTargetsToRows,
  type DomainMiddlewareRow,
  type DomainRow,
  type EnvVarRow,
  type EnvVarTargetRow,
  type AppChildRows,
  type AppRow,
} from "./app-graph-rows";

/**
 * The READ seam for the project graph (relational-store PLAN §6 "Reads /
 * performance — batch-load is mandatory"). Because §1 removed JSONB, every
 * project read JOINs its 5–6 child tables; over the old in-memory cache these
 * fan-outs were free, but async they become real round-trips. So the data layer
 * NEVER loads children per-project in a loop — it goes through here:
 *
 *  - {@link loadAppGraph} — ONE project + all its children in a bounded query
 *    set (the aggregate loader routed from runDeployment / renderAppStack /
 *    getAppById / the GraphQL detail resolver).
 *  - {@link loadAppsByTeam} / {@link loadAppsByIds} — N apps with all
 *    children batch-loaded by a single `inArray` per child table (so a list of N
 *    apps is a BOUNDED number of queries, not N×6).
 *
 * A `DbReader` is `getDb()` or a `tx`, so a transaction can read through the same
 * assembler it later writes through (no second connection, consistent snapshot).
 */
type DbReader = ReturnType<typeof getDb> | DbTx;

/* ------------------------------------------------------------------ */
/* Child batch-loading                                                 */
/* ------------------------------------------------------------------ */

/** All child rows for a set of project ids, grouped by project id. */
async function loadChildrenByAppIds(
  db: DbReader,
  ids: string[],
): Promise<Map<string, AppChildRows>> {
  const out = new Map<string, AppChildRows>();
  for (const id of ids)
    out.set(id, {
      build: null,
      methodSettings: null,
      dev: null,
      volumes: [],
      mounts: [],
    });
  if (ids.length === 0) return out;

  // One query per child table over the whole id set (NOT per project).
  const [builds, settings, devs, volumes, mounts] = await Promise.all([
    db.select().from(appBuild).where(inArray(appBuild.appId, ids)),
    db
      .select()
      .from(appBuildMethodSettings)
      .where(inArray(appBuildMethodSettings.appId, ids)),
    db.select().from(appDev).where(inArray(appDev.appId, ids)),
    db
      .select()
      .from(appVolumes)
      .where(inArray(appVolumes.appId, ids))
      .orderBy(asc(appVolumes.appId), asc(appVolumes.position)),
    db
      .select()
      .from(appMounts)
      .where(inArray(appMounts.appId, ids))
      .orderBy(asc(appMounts.appId), asc(appMounts.position)),
  ]);

  for (const b of builds) out.get(b.appId)!.build = b;
  for (const s of settings) out.get(s.appId)!.methodSettings = s;
  for (const dv of devs) out.get(dv.appId)!.dev = dv;
  for (const v of volumes) out.get(v.appId)!.volumes.push(v);
  for (const m of mounts) out.get(m.appId)!.mounts.push(m);
  return out;
}

/* ------------------------------------------------------------------ */
/* App loaders                                                     */
/* ------------------------------------------------------------------ */

/** Assemble a list of {@link App}s from their parent rows + batch-loaded children. */
async function assembleApps(
  db: DbReader,
  rows: AppRow[],
): Promise<App[]> {
  if (rows.length === 0) return [];
  const children = await loadChildrenByAppIds(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => assembleApp(r, children.get(r.id)!));
}

/**
 * One project + all its children in a bounded query set, or null if absent. The
 * aggregate loader (PLAN §6 "One aggregate project loader"). NOT team-scoped —
 * callers that need a team check pass `teamId` or filter the result.
 */
export async function loadAppGraph(
  id: string,
  db: DbReader = getDb(),
): Promise<App | null> {
  const rows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  if (rows.length === 0) return null;
  const [p] = await assembleApps(db, rows);
  return p ?? null;
}

/** Same as {@link loadAppGraph} but by slug. */
export async function loadAppGraphBySlug(
  slug: string,
  db: DbReader = getDb(),
): Promise<App | null> {
  const rows = await db
    .select()
    .from(apps)
    .where(eq(apps.slug, slug))
    .limit(1);
  if (rows.length === 0) return null;
  const [p] = await assembleApps(db, rows);
  return p ?? null;
}

/** Every project in a team, fully assembled (children batch-loaded). */
export async function loadAppsByTeam(
  teamId: string,
  db: DbReader = getDb(),
): Promise<App[]> {
  const rows = await db
    .select()
    .from(apps)
    .where(eq(apps.teamId, teamId));
  return assembleApps(db, rows);
}

/** A specific set of apps, fully assembled (children batch-loaded). */
export async function loadAppsByIds(
  ids: string[],
  db: DbReader = getDb(),
): Promise<App[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(apps).where(inArray(apps.id, ids));
  return assembleApps(db, rows);
}

/* ------------------------------------------------------------------ */
/* Summary preload (the N+1 killer for listApps/summarize)         */
/* ------------------------------------------------------------------ */

/**
 * The per-team data `summarize` needs as a PURE function (PLAN §6 "`summarize()`
 * is N+1"): the latest deployment per project (one query) and the domain count
 * per project (one GROUP BY) — so a list of N apps costs a bounded number of
 * queries instead of N×2. Keyed by project id.
 */
export interface SummaryPreload {
  latestDeployments: Map<string, Deployment>;
  domainCounts: Map<string, number>;
}

/** Batch-load the latest deployment + domain count for a set of apps. */
export async function preloadSummaries(
  proj: App[],
  db: DbReader = getDb(),
): Promise<SummaryPreload> {
  const latestIds = proj
    .map((p) => p.latestDeploymentId)
    .filter((id): id is string => id != null);
  const appIds = proj.map((p) => p.id);

  const [latestRows, domainRows] = await Promise.all([
    latestIds.length
      ? db.select().from(deployments).where(inArray(deployments.id, latestIds))
      : Promise.resolve([]),
    appIds.length
      ? db
          .select({
            appId: domains.appId,
            n: sql<number>`count(*)`.mapWith(Number),
          })
          .from(domains)
          .where(inArray(domains.appId, appIds))
          .groupBy(domains.appId)
      : Promise.resolve([]),
  ]);

  const latestDeployments = new Map<string, Deployment>();
  for (const row of latestRows) {
    const dep = assembleDeployment(row);
    latestDeployments.set(dep.id, dep);
  }
  const domainCounts = new Map<string, number>();
  for (const row of domainRows) domainCounts.set(row.appId, row.n);
  return { latestDeployments, domainCounts };
}

/* ------------------------------------------------------------------ */
/* Deployment loaders                                                  */
/* ------------------------------------------------------------------ */

/** A single deployment by id (null if absent). */
export async function loadDeployment(
  id: string,
  db: DbReader = getDb(),
): Promise<Deployment | null> {
  const rows = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, id))
    .limit(1);
  return rows[0] ? assembleDeployment(rows[0]) : null;
}

/**
 * A project's deployments, newest-first with the deterministic `seq` tie-break
 * (PLAN §5/§6 "Push ORDER BY created_at DESC, seq DESC + LIMIT into SQL"). The
 * optional `limit` is the list push-down — slicing happens in SQL, not memory.
 */
export async function loadDeploymentsForApp(
  appId: string,
  opts: { limit?: number } = {},
  db: DbReader = getDb(),
): Promise<Deployment[]> {
  const q = db
    .select()
    .from(deployments)
    .where(eq(deployments.appId, appId))
    .orderBy(desc(deployments.createdAt), desc(deployments.seq));
  const rows = await (opts.limit != null ? q.limit(opts.limit) : q);
  return rows.map(assembleDeployment);
}

/* ------------------------------------------------------------------ */
/* Domain loaders                                                      */
/* ------------------------------------------------------------------ */

/** Assemble domains from rows, batch-loading their middlewares. */
async function assembleDomains(
  db: DbReader,
  rows: DomainRow[],
): Promise<Domain[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const mwRows = await db
    .select()
    .from(domainMiddlewares)
    .where(inArray(domainMiddlewares.domainId, ids))
    .orderBy(asc(domainMiddlewares.domainId), asc(domainMiddlewares.position));
  const byDomain = new Map<string, DomainMiddlewareRow[]>();
  for (const r of mwRows) {
    const list = byDomain.get(r.domainId) ?? [];
    list.push(r);
    byDomain.set(r.domainId, list);
  }
  return rows.map((r) => assembleDomain(r, byDomain.get(r.id) ?? []));
}

/** All domains for a project (with middlewares), insertion order. */
export async function loadDomainsForApp(
  appId: string,
  db: DbReader = getDb(),
): Promise<Domain[]> {
  const rows = await db
    .select()
    .from(domains)
    .where(eq(domains.appId, appId));
  return assembleDomains(db, rows);
}

/** A single domain by id (with middlewares), null if absent. */
export async function loadDomain(
  id: string,
  db: DbReader = getDb(),
): Promise<Domain | null> {
  const rows = await db.select().from(domains).where(eq(domains.id, id)).limit(1);
  const [d] = await assembleDomains(db, rows);
  return d ?? null;
}

/** Insert a {@link Domain} + its ordered middleware rows (the shared write seam). */
export async function insertDomain(db: DbReader, domain: Domain): Promise<void> {
  await db.insert(domains).values(domainToRow(domain));
  const mw = domainMiddlewaresToRows(domain);
  if (mw.length > 0) await db.insert(domainMiddlewares).values(mw);
}

/** Every domain across a set of apps, batch-loaded (for listDomains). */
export async function loadDomainsForApps(
  appIds: string[],
  db: DbReader = getDb(),
): Promise<Domain[]> {
  if (appIds.length === 0) return [];
  const rows = await db
    .select()
    .from(domains)
    .where(inArray(domains.appId, appIds));
  return assembleDomains(db, rows);
}

/* ------------------------------------------------------------------ */
/* EnvVar loaders                                                      */
/* ------------------------------------------------------------------ */

/** Assemble env vars from rows, batch-loading their targets. */
async function assembleEnvVars(
  db: DbReader,
  rows: EnvVarRow[],
): Promise<EnvVar[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const targetRows = await db
    .select()
    .from(envVarTargets)
    .where(inArray(envVarTargets.envVarId, ids));
  const byVar = new Map<string, EnvVarTargetRow[]>();
  for (const r of targetRows) {
    const list = byVar.get(r.envVarId) ?? [];
    list.push(r);
    byVar.set(r.envVarId, list);
  }
  return rows.map((r) => assembleEnvVar(r, byVar.get(r.id) ?? []));
}

/** All env vars for a project (with targets). */
export async function loadEnvVarsForApp(
  appId: string,
  db: DbReader = getDb(),
): Promise<EnvVar[]> {
  const rows = await db
    .select()
    .from(envVars)
    .where(eq(envVars.appId, appId));
  return assembleEnvVars(db, rows);
}

/** Env vars across a set of apps, batch-loaded (for the global Variables tab + deploy env). */
export async function loadEnvVarsForApps(
  appIds: string[],
  db: DbReader = getDb(),
): Promise<EnvVar[]> {
  if (appIds.length === 0) return [];
  const rows = await db
    .select()
    .from(envVars)
    .where(inArray(envVars.appId, appIds));
  return assembleEnvVars(db, rows);
}

/** A single env var by id (with targets), null if absent. */
export async function loadEnvVar(
  id: string,
  db: DbReader = getDb(),
): Promise<EnvVar | null> {
  const rows = await db.select().from(envVars).where(eq(envVars.id, id)).limit(1);
  const [e] = await assembleEnvVars(db, rows);
  return e ?? null;
}

/**
 * Insert {@link EnvVar}s + their target junction rows (one multi-row insert each).
 * The shared write seam `createApp` / `setAppEnv` / `upsertEnv` use so the
 * env-var → row mapping (and the targets junction) lives in one place. Pass a `tx`
 * so it joins the caller's transaction.
 */
export async function insertEnvVars(db: DbReader, vars: EnvVar[]): Promise<void> {
  if (vars.length === 0) return;
  await db.insert(envVars).values(vars.map(envVarToRow));
  const targets = vars.flatMap(envVarTargetsToRows);
  if (targets.length > 0) await db.insert(envVarTargets).values(targets);
}

/**
 * Load a project only if it belongs to `teamId` (the standard ownership gate as
 * a single call): the full assembled {@link App} or null when absent / not
 * owned. The relational replacement for the old
 * `read().apps.find(p => p.id === id && p.teamId === teamId)`.
 */
export async function loadTeamApp(
  appId: string,
  teamId: string,
  db: DbReader = getDb(),
): Promise<App | null> {
  const p = await loadAppGraph(appId, db);
  return p && p.teamId === teamId ? p : null;
}

/** True if a project belongs to a team (the standard ownership gate). */
export async function appInTeam(
  appId: string,
  teamId: string,
  db: DbReader = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: apps.id })
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.teamId, teamId)))
    .limit(1);
  return rows.length > 0;
}

// NOTE: shared env GROUPS were replaced by the unified individual shared-var
// model (ADR-0010). Their loaders live in lib/data/shared-vars.ts now
// (loadSharedVarsForApp for the deploy edge, listSharedVars for the UI).
