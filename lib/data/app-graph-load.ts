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
  services,
  serviceBuild,
  serviceBuildMethodSettings,
  serviceDev,
  serviceMounts,
  serviceVolumes,
  sharedEnvGroups,
  sharedEnvGroupServices,
  sharedEnvGroupTargets,
  sharedEnvGroupVars,
} from "../db/schema/control-plane";
import type { Deployment, Domain, EnvVar, Service, SharedEnvGroup } from "../types";
import {
  assembleDeployment,
  assembleDomain,
  assembleEnvVar,
  assembleService,
  assembleSharedEnvGroup,
  domainToRow,
  domainMiddlewaresToRows,
  envVarToRow,
  envVarTargetsToRows,
  type DomainMiddlewareRow,
  type DomainRow,
  type EnvVarRow,
  type EnvVarTargetRow,
  type ServiceChildRows,
  type ServiceRow,
  type SharedEnvGroupRow,
} from "./service-graph-rows";

/**
 * The READ seam for the project graph (relational-store PLAN §6 "Reads /
 * performance — batch-load is mandatory"). Because §1 removed JSONB, every
 * project read JOINs its 5–6 child tables; over the old in-memory cache these
 * fan-outs were free, but async they become real round-trips. So the data layer
 * NEVER loads children per-project in a loop — it goes through here:
 *
 *  - {@link loadServiceGraph} — ONE project + all its children in a bounded query
 *    set (the aggregate loader routed from runDeployment / renderServiceStack /
 *    getServiceById / the GraphQL detail resolver).
 *  - {@link loadServicesByTeam} / {@link loadServicesByIds} — N services with all
 *    children batch-loaded by a single `inArray` per child table (so a list of N
 *    services is a BOUNDED number of queries, not N×6).
 *
 * A `DbReader` is `getDb()` or a `tx`, so a transaction can read through the same
 * assembler it later writes through (no second connection, consistent snapshot).
 */
type DbReader = ReturnType<typeof getDb> | DbTx;

/* ------------------------------------------------------------------ */
/* Child batch-loading                                                 */
/* ------------------------------------------------------------------ */

/** All child rows for a set of project ids, grouped by project id. */
async function loadChildrenByServiceIds(
  db: DbReader,
  ids: string[],
): Promise<Map<string, ServiceChildRows>> {
  const out = new Map<string, ServiceChildRows>();
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
    db.select().from(serviceBuild).where(inArray(serviceBuild.serviceId, ids)),
    db
      .select()
      .from(serviceBuildMethodSettings)
      .where(inArray(serviceBuildMethodSettings.serviceId, ids)),
    db.select().from(serviceDev).where(inArray(serviceDev.serviceId, ids)),
    db
      .select()
      .from(serviceVolumes)
      .where(inArray(serviceVolumes.serviceId, ids))
      .orderBy(asc(serviceVolumes.serviceId), asc(serviceVolumes.position)),
    db
      .select()
      .from(serviceMounts)
      .where(inArray(serviceMounts.serviceId, ids))
      .orderBy(asc(serviceMounts.serviceId), asc(serviceMounts.position)),
  ]);

  for (const b of builds) out.get(b.serviceId)!.build = b;
  for (const s of settings) out.get(s.serviceId)!.methodSettings = s;
  for (const dv of devs) out.get(dv.serviceId)!.dev = dv;
  for (const v of volumes) out.get(v.serviceId)!.volumes.push(v);
  for (const m of mounts) out.get(m.serviceId)!.mounts.push(m);
  return out;
}

/* ------------------------------------------------------------------ */
/* Service loaders                                                     */
/* ------------------------------------------------------------------ */

/** Assemble a list of {@link Service}s from their parent rows + batch-loaded children. */
async function assembleServices(
  db: DbReader,
  rows: ServiceRow[],
): Promise<Service[]> {
  if (rows.length === 0) return [];
  const children = await loadChildrenByServiceIds(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => assembleService(r, children.get(r.id)!));
}

/**
 * One project + all its children in a bounded query set, or null if absent. The
 * aggregate loader (PLAN §6 "One aggregate project loader"). NOT team-scoped —
 * callers that need a team check pass `teamId` or filter the result.
 */
export async function loadServiceGraph(
  id: string,
  db: DbReader = getDb(),
): Promise<Service | null> {
  const rows = await db.select().from(services).where(eq(services.id, id)).limit(1);
  if (rows.length === 0) return null;
  const [p] = await assembleServices(db, rows);
  return p ?? null;
}

/** Same as {@link loadServiceGraph} but by slug. */
export async function loadServiceGraphBySlug(
  slug: string,
  db: DbReader = getDb(),
): Promise<Service | null> {
  const rows = await db
    .select()
    .from(services)
    .where(eq(services.slug, slug))
    .limit(1);
  if (rows.length === 0) return null;
  const [p] = await assembleServices(db, rows);
  return p ?? null;
}

/** Every project in a team, fully assembled (children batch-loaded). */
export async function loadServicesByTeam(
  teamId: string,
  db: DbReader = getDb(),
): Promise<Service[]> {
  const rows = await db
    .select()
    .from(services)
    .where(eq(services.teamId, teamId));
  return assembleServices(db, rows);
}

/** A specific set of services, fully assembled (children batch-loaded). */
export async function loadServicesByIds(
  ids: string[],
  db: DbReader = getDb(),
): Promise<Service[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(services).where(inArray(services.id, ids));
  return assembleServices(db, rows);
}

/* ------------------------------------------------------------------ */
/* Summary preload (the N+1 killer for listServices/summarize)         */
/* ------------------------------------------------------------------ */

/**
 * The per-team data `summarize` needs as a PURE function (PLAN §6 "`summarize()`
 * is N+1"): the latest deployment per project (one query) and the domain count
 * per project (one GROUP BY) — so a list of N services costs a bounded number of
 * queries instead of N×2. Keyed by project id.
 */
export interface SummaryPreload {
  latestDeployments: Map<string, Deployment>;
  domainCounts: Map<string, number>;
}

/** Batch-load the latest deployment + domain count for a set of services. */
export async function preloadSummaries(
  proj: Service[],
  db: DbReader = getDb(),
): Promise<SummaryPreload> {
  const latestIds = proj
    .map((p) => p.latestDeploymentId)
    .filter((id): id is string => id != null);
  const serviceIds = proj.map((p) => p.id);

  const [latestRows, domainRows] = await Promise.all([
    latestIds.length
      ? db.select().from(deployments).where(inArray(deployments.id, latestIds))
      : Promise.resolve([]),
    serviceIds.length
      ? db
          .select({
            serviceId: domains.serviceId,
            n: sql<number>`count(*)`.mapWith(Number),
          })
          .from(domains)
          .where(inArray(domains.serviceId, serviceIds))
          .groupBy(domains.serviceId)
      : Promise.resolve([]),
  ]);

  const latestDeployments = new Map<string, Deployment>();
  for (const row of latestRows) {
    const dep = assembleDeployment(row);
    latestDeployments.set(dep.id, dep);
  }
  const domainCounts = new Map<string, number>();
  for (const row of domainRows) domainCounts.set(row.serviceId, row.n);
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
export async function loadDeploymentsForService(
  serviceId: string,
  opts: { limit?: number } = {},
  db: DbReader = getDb(),
): Promise<Deployment[]> {
  const q = db
    .select()
    .from(deployments)
    .where(eq(deployments.serviceId, serviceId))
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
export async function loadDomainsForService(
  serviceId: string,
  db: DbReader = getDb(),
): Promise<Domain[]> {
  const rows = await db
    .select()
    .from(domains)
    .where(eq(domains.serviceId, serviceId));
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

/** Every domain across a set of services, batch-loaded (for listDomains). */
export async function loadDomainsForServices(
  serviceIds: string[],
  db: DbReader = getDb(),
): Promise<Domain[]> {
  if (serviceIds.length === 0) return [];
  const rows = await db
    .select()
    .from(domains)
    .where(inArray(domains.serviceId, serviceIds));
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
export async function loadEnvVarsForService(
  serviceId: string,
  db: DbReader = getDb(),
): Promise<EnvVar[]> {
  const rows = await db
    .select()
    .from(envVars)
    .where(eq(envVars.serviceId, serviceId));
  return assembleEnvVars(db, rows);
}

/** Env vars across a set of services, batch-loaded (for the global Variables tab + deploy env). */
export async function loadEnvVarsForServices(
  serviceIds: string[],
  db: DbReader = getDb(),
): Promise<EnvVar[]> {
  if (serviceIds.length === 0) return [];
  const rows = await db
    .select()
    .from(envVars)
    .where(inArray(envVars.serviceId, serviceIds));
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
 * The shared write seam `createService` / `setServiceEnv` / `upsertEnv` use so the
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
 * a single call): the full assembled {@link Service} or null when absent / not
 * owned. The relational replacement for the old
 * `read().services.find(p => p.id === id && p.teamId === teamId)`.
 */
export async function loadTeamService(
  serviceId: string,
  teamId: string,
  db: DbReader = getDb(),
): Promise<Service | null> {
  const p = await loadServiceGraph(serviceId, db);
  return p && p.teamId === teamId ? p : null;
}

/** True if a project belongs to a team (the standard ownership gate). */
export async function serviceInTeam(
  serviceId: string,
  teamId: string,
  db: DbReader = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: services.id })
    .from(services)
    .where(and(eq(services.id, serviceId), eq(services.teamId, teamId)))
    .limit(1);
  return rows.length > 0;
}

/* ------------------------------------------------------------------ */
/* Shared env groups                                                   */
/* ------------------------------------------------------------------ */

/** Assemble shared env groups from parent rows, batch-loading the 3 child sets. */
async function assembleSharedEnvGroups(
  db: DbReader,
  rows: SharedEnvGroupRow[],
): Promise<SharedEnvGroup[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [vars, projectsRows, targets] = await Promise.all([
    db.select().from(sharedEnvGroupVars).where(inArray(sharedEnvGroupVars.groupId, ids)),
    db
      .select()
      .from(sharedEnvGroupServices)
      .where(inArray(sharedEnvGroupServices.groupId, ids)),
    db
      .select()
      .from(sharedEnvGroupTargets)
      .where(inArray(sharedEnvGroupTargets.groupId, ids)),
  ]);
  const varsBy = groupBy(vars, (v) => v.groupId);
  const projBy = groupBy(projectsRows, (p) => p.groupId);
  const tgtBy = groupBy(targets, (t) => t.groupId);
  return rows.map((r) =>
    assembleSharedEnvGroup(r, varsBy.get(r.id) ?? [], projBy.get(r.id) ?? [], tgtBy.get(r.id) ?? []),
  );
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const list = out.get(k) ?? [];
    list.push(item);
    out.set(k, list);
  }
  return out;
}

/** Every shared env group in a team (with children). */
export async function loadSharedEnvGroupsForTeam(
  teamId: string,
  db: DbReader = getDb(),
): Promise<SharedEnvGroup[]> {
  const rows = await db
    .select()
    .from(sharedEnvGroups)
    .where(eq(sharedEnvGroups.teamId, teamId));
  return assembleSharedEnvGroups(db, rows);
}

/** A single shared env group by id (with children), null if absent. */
export async function loadSharedEnvGroup(
  id: string,
  db: DbReader = getDb(),
): Promise<SharedEnvGroup | null> {
  const rows = await db
    .select()
    .from(sharedEnvGroups)
    .where(eq(sharedEnvGroups.id, id))
    .limit(1);
  const [g] = await assembleSharedEnvGroups(db, rows);
  return g ?? null;
}

/**
 * Shared env groups ATTACHED to a project (with children) — the bounded set the
 * deploy/dev env resolution needs, joined through the `shared_env_group_services`
 * junction (so it never loads the whole team's groups into the build).
 */
export async function loadSharedEnvGroupsForService(
  serviceId: string,
  db: DbReader = getDb(),
): Promise<SharedEnvGroup[]> {
  const attached = await db
    .select({ groupId: sharedEnvGroupServices.groupId })
    .from(sharedEnvGroupServices)
    .where(eq(sharedEnvGroupServices.serviceId, serviceId));
  if (attached.length === 0) return [];
  const rows = await db
    .select()
    .from(sharedEnvGroups)
    .where(inArray(sharedEnvGroups.id, attached.map((a) => a.groupId)));
  return assembleSharedEnvGroups(db, rows);
}
