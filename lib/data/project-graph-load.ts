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
  projects,
  projectBuild,
  projectBuildMethodSettings,
  projectDev,
  projectExposes,
  projectMounts,
  projectVolumes,
} from "../db/schema/control-plane";
import type { Deployment, Domain, EnvVar, Project } from "../types";
import {
  assembleDeployment,
  assembleDomain,
  assembleEnvVar,
  assembleProject,
  domainToRow,
  domainMiddlewaresToRows,
  envVarToRow,
  envVarTargetsToRows,
  type DomainMiddlewareRow,
  type DomainRow,
  type EnvVarRow,
  type EnvVarTargetRow,
  type ProjectChildRows,
  type ProjectRow,
} from "./project-graph-rows";

/**
 * The READ seam for the project graph (relational-store PLAN §6 "Reads /
 * performance — batch-load is mandatory"). Because §1 removed JSONB, every
 * project read JOINs its 5–6 child tables; over the old in-memory cache these
 * fan-outs were free, but async they become real round-trips. So the data layer
 * NEVER loads children per-project in a loop — it goes through here:
 *
 *  - {@link loadProjectGraph} — ONE project + all its children in a bounded query
 *    set (the aggregate loader routed from runDeployment / renderProjectStack /
 *    getProjectById / the GraphQL detail resolver).
 *  - {@link loadProjectsByTeam} / {@link loadProjectsByIds} — N projects with all
 *    children batch-loaded by a single `inArray` per child table (so a list of N
 *    projects is a BOUNDED number of queries, not N×6).
 *
 * A `DbReader` is `getDb()` or a `tx`, so a transaction can read through the same
 * assembler it later writes through (no second connection, consistent snapshot).
 */
type DbReader = ReturnType<typeof getDb> | DbTx;

/* ------------------------------------------------------------------ */
/* Child batch-loading                                                 */
/* ------------------------------------------------------------------ */

/** All child rows for a set of project ids, grouped by project id. */
async function loadChildrenByProjectIds(
  db: DbReader,
  ids: string[],
): Promise<Map<string, ProjectChildRows>> {
  const out = new Map<string, ProjectChildRows>();
  for (const id of ids)
    out.set(id, {
      build: null,
      methodSettings: null,
      dev: null,
      exposes: [],
      volumes: [],
      mounts: [],
    });
  if (ids.length === 0) return out;

  // One query per child table over the whole id set (NOT per project).
  const [builds, settings, devs, exposes, volumes, mounts] = await Promise.all([
    db.select().from(projectBuild).where(inArray(projectBuild.projectId, ids)),
    db
      .select()
      .from(projectBuildMethodSettings)
      .where(inArray(projectBuildMethodSettings.projectId, ids)),
    db.select().from(projectDev).where(inArray(projectDev.projectId, ids)),
    db
      .select()
      .from(projectExposes)
      .where(inArray(projectExposes.projectId, ids))
      .orderBy(asc(projectExposes.projectId), asc(projectExposes.position)),
    db
      .select()
      .from(projectVolumes)
      .where(inArray(projectVolumes.projectId, ids))
      .orderBy(asc(projectVolumes.projectId), asc(projectVolumes.position)),
    db
      .select()
      .from(projectMounts)
      .where(inArray(projectMounts.projectId, ids))
      .orderBy(asc(projectMounts.projectId), asc(projectMounts.position)),
  ]);

  for (const b of builds) out.get(b.projectId)!.build = b;
  for (const s of settings) out.get(s.projectId)!.methodSettings = s;
  for (const dv of devs) out.get(dv.projectId)!.dev = dv;
  for (const e of exposes) out.get(e.projectId)!.exposes.push(e);
  for (const v of volumes) out.get(v.projectId)!.volumes.push(v);
  for (const m of mounts) out.get(m.projectId)!.mounts.push(m);
  return out;
}

/* ------------------------------------------------------------------ */
/* Project loaders                                                     */
/* ------------------------------------------------------------------ */

/** Assemble a list of {@link Project}s from their parent rows + batch-loaded children. */
async function assembleProjects(
  db: DbReader,
  rows: ProjectRow[],
): Promise<Project[]> {
  if (rows.length === 0) return [];
  const children = await loadChildrenByProjectIds(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => assembleProject(r, children.get(r.id)!));
}

/**
 * One project + all its children in a bounded query set, or null if absent. The
 * aggregate loader (PLAN §6 "One aggregate project loader"). NOT team-scoped —
 * callers that need a team check pass `teamId` or filter the result.
 */
export async function loadProjectGraph(
  id: string,
  db: DbReader = getDb(),
): Promise<Project | null> {
  const rows = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
  if (rows.length === 0) return null;
  const [p] = await assembleProjects(db, rows);
  return p ?? null;
}

/** Same as {@link loadProjectGraph} but by slug. */
export async function loadProjectGraphBySlug(
  slug: string,
  db: DbReader = getDb(),
): Promise<Project | null> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.slug, slug))
    .limit(1);
  if (rows.length === 0) return null;
  const [p] = await assembleProjects(db, rows);
  return p ?? null;
}

/** Every project in a team, fully assembled (children batch-loaded). */
export async function loadProjectsByTeam(
  teamId: string,
  db: DbReader = getDb(),
): Promise<Project[]> {
  const rows = await db
    .select()
    .from(projects)
    .where(eq(projects.teamId, teamId));
  return assembleProjects(db, rows);
}

/** A specific set of projects, fully assembled (children batch-loaded). */
export async function loadProjectsByIds(
  ids: string[],
  db: DbReader = getDb(),
): Promise<Project[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(projects).where(inArray(projects.id, ids));
  return assembleProjects(db, rows);
}

/* ------------------------------------------------------------------ */
/* Summary preload (the N+1 killer for listProjects/summarize)         */
/* ------------------------------------------------------------------ */

/**
 * The per-team data `summarize` needs as a PURE function (PLAN §6 "`summarize()`
 * is N+1"): the latest deployment per project (one query) and the domain count
 * per project (one GROUP BY) — so a list of N projects costs a bounded number of
 * queries instead of N×2. Keyed by project id.
 */
export interface SummaryPreload {
  latestDeployments: Map<string, Deployment>;
  domainCounts: Map<string, number>;
}

/** Batch-load the latest deployment + domain count for a set of projects. */
export async function preloadSummaries(
  proj: Project[],
  db: DbReader = getDb(),
): Promise<SummaryPreload> {
  const latestIds = proj
    .map((p) => p.latestDeploymentId)
    .filter((id): id is string => id != null);
  const projectIds = proj.map((p) => p.id);

  const [latestRows, domainRows] = await Promise.all([
    latestIds.length
      ? db.select().from(deployments).where(inArray(deployments.id, latestIds))
      : Promise.resolve([]),
    projectIds.length
      ? db
          .select({
            projectId: domains.projectId,
            n: sql<number>`count(*)`.mapWith(Number),
          })
          .from(domains)
          .where(inArray(domains.projectId, projectIds))
          .groupBy(domains.projectId)
      : Promise.resolve([]),
  ]);

  const latestDeployments = new Map<string, Deployment>();
  for (const row of latestRows) {
    const dep = assembleDeployment(row);
    latestDeployments.set(dep.id, dep);
  }
  const domainCounts = new Map<string, number>();
  for (const row of domainRows) domainCounts.set(row.projectId, row.n);
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
export async function loadDeploymentsForProject(
  projectId: string,
  opts: { limit?: number } = {},
  db: DbReader = getDb(),
): Promise<Deployment[]> {
  const q = db
    .select()
    .from(deployments)
    .where(eq(deployments.projectId, projectId))
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
export async function loadDomainsForProject(
  projectId: string,
  db: DbReader = getDb(),
): Promise<Domain[]> {
  const rows = await db
    .select()
    .from(domains)
    .where(eq(domains.projectId, projectId));
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

/** Every domain across a set of projects, batch-loaded (for listDomains). */
export async function loadDomainsForProjects(
  projectIds: string[],
  db: DbReader = getDb(),
): Promise<Domain[]> {
  if (projectIds.length === 0) return [];
  const rows = await db
    .select()
    .from(domains)
    .where(inArray(domains.projectId, projectIds));
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
export async function loadEnvVarsForProject(
  projectId: string,
  db: DbReader = getDb(),
): Promise<EnvVar[]> {
  const rows = await db
    .select()
    .from(envVars)
    .where(eq(envVars.projectId, projectId));
  return assembleEnvVars(db, rows);
}

/** Env vars across a set of projects, batch-loaded (for the global Variables tab + deploy env). */
export async function loadEnvVarsForProjects(
  projectIds: string[],
  db: DbReader = getDb(),
): Promise<EnvVar[]> {
  if (projectIds.length === 0) return [];
  const rows = await db
    .select()
    .from(envVars)
    .where(inArray(envVars.projectId, projectIds));
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
 * The shared write seam `createProject` / `setProjectEnv` / `upsertEnv` use so the
 * env-var → row mapping (and the targets junction) lives in one place. Pass a `tx`
 * so it joins the caller's transaction.
 */
export async function insertEnvVars(db: DbReader, vars: EnvVar[]): Promise<void> {
  if (vars.length === 0) return;
  await db.insert(envVars).values(vars.map(envVarToRow));
  const targets = vars.flatMap(envVarTargetsToRows);
  if (targets.length > 0) await db.insert(envVarTargets).values(targets);
}

/** True if a project belongs to a team (the standard ownership gate). */
export async function projectInTeam(
  projectId: string,
  teamId: string,
  db: DbReader = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.teamId, teamId)))
    .limit(1);
  return rows.length > 0;
}
