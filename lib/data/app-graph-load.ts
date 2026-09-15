import "server-only";

import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";

import { getDb } from "../db/client";
import { inAppScope, narrowedScope } from "../auth/request-context";
import type { DbTx } from "../db/client";
import {
  apps,
  appBuild,
  appBuildMethodSettings,
  appMounts,
  appPorts,
  appVolumes,
} from "../db/schema/control-plane/apps";
import { deployments } from "../db/schema/control-plane/deployments";
import { domains, domainMiddlewares } from "../db/schema/control-plane/domains";
import { envVars, envVarTargets } from "../db/schema/control-plane/env-vars";
import type { App, DeploySource } from "../types/app";
import type { Deployment } from "../types/deployment";
import type { Domain } from "../types/domain";
import type { EnvVar } from "../types/env";
import {
  assembleApp,
  type AppChildRows,
  type AppRow,
} from "./app-graph-rows/app";
import { assembleDeployment } from "./app-graph-rows/deployment";
import {
  assembleDomain,
  domainToRow,
  domainMiddlewaresToRows,
  type DomainMiddlewareRow,
  type DomainRow,
} from "./app-graph-rows/domain";
import {
  assembleEnvVar,
  envVarToRow,
  envVarTargetsToRows,
  type EnvVarRow,
  type EnvVarTargetRow,
} from "./app-graph-rows/env-var";

type DbReader = ReturnType<typeof getDb> | DbTx;

async function loadChildrenByAppIds(
  db: DbReader,
  ids: string[],
): Promise<Map<string, AppChildRows>> {
  const out = new Map<string, AppChildRows>();
  for (const id of ids)
    out.set(id, {
      build: null,
      methodSettings: null,
      volumes: [],
      ports: [],
      mounts: [],
    });
  if (ids.length === 0) return out;

  const [builds, settings, volumes, ports, mounts] = await Promise.all([
    db.select().from(appBuild).where(inArray(appBuild.appId, ids)),
    db
      .select()
      .from(appBuildMethodSettings)
      .where(inArray(appBuildMethodSettings.appId, ids)),
    db
      .select()
      .from(appVolumes)
      .where(inArray(appVolumes.appId, ids))
      .orderBy(asc(appVolumes.appId), asc(appVolumes.position)),
    db
      .select()
      .from(appPorts)
      .where(inArray(appPorts.appId, ids))
      .orderBy(asc(appPorts.appId), asc(appPorts.position)),
    db
      .select()
      .from(appMounts)
      .where(inArray(appMounts.appId, ids))
      .orderBy(asc(appMounts.appId), asc(appMounts.position)),
  ]);

  for (const b of builds) out.get(b.appId)!.build = b;
  for (const s of settings) out.get(s.appId)!.methodSettings = s;
  for (const v of volumes) out.get(v.appId)!.volumes.push(v);
  for (const p of ports) out.get(p.appId)!.ports.push(p);
  for (const m of mounts) out.get(m.appId)!.mounts.push(m);
  return out;
}

async function assembleApps(db: DbReader, rows: AppRow[]): Promise<App[]> {
  if (rows.length === 0) return [];
  const children = await loadChildrenByAppIds(
    db,
    rows.map((r) => r.id),
  );
  return rows.map((r) => assembleApp(r, children.get(r.id)!));
}

export async function loadAppGraph(
  id: string,
  db: DbReader = getDb(),
): Promise<App | null> {
  const rows = await db.select().from(apps).where(eq(apps.id, id)).limit(1);
  if (rows.length === 0) return null;
  const [p] = await assembleApps(db, rows);
  return p ?? null;
}

export async function loadAppGraphBySlug(
  slug: string,
  db: DbReader = getDb(),
): Promise<App | null> {
  const rows = await db.select().from(apps).where(eq(apps.slug, slug)).limit(1);
  if (rows.length === 0) return null;
  const [p] = await assembleApps(db, rows);
  return p ?? null;
}

export async function loadAppsByTeam(
  teamId: string,
  db: DbReader = getDb(),
): Promise<App[]> {
  const rows = await db.select().from(apps).where(eq(apps.teamId, teamId));
  return assembleApps(db, rows);
}

export async function loadAppsByIds(
  ids: string[],
  db: DbReader = getDb(),
): Promise<App[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(apps).where(inArray(apps.id, ids));
  return assembleApps(db, rows);
}

export interface SummaryPreload {
  latestDeployments: Map<string, Deployment>;
  domainCounts: Map<string, number>;
}

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

export async function loadDomainsForApp(
  appId: string,
  db: DbReader = getDb(),
): Promise<Domain[]> {
  const rows = await db.select().from(domains).where(eq(domains.appId, appId));
  return assembleDomains(db, rows);
}

export async function loadDomain(
  id: string,
  db: DbReader = getDb(),
): Promise<Domain | null> {
  const rows = await db
    .select()
    .from(domains)
    .where(eq(domains.id, id))
    .limit(1);
  const [d] = await assembleDomains(db, rows);
  return d ?? null;
}

export async function insertDomain(
  db: DbReader,
  domain: Domain,
): Promise<void> {
  await db.insert(domains).values(domainToRow(domain));
  const mw = domainMiddlewaresToRows(domain);
  if (mw.length > 0) await db.insert(domainMiddlewares).values(mw);
}

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

export async function loadEnvVarsForApp(
  appId: string,
  db: DbReader = getDb(),
): Promise<EnvVar[]> {
  const rows = await db.select().from(envVars).where(eq(envVars.appId, appId));
  return assembleEnvVars(db, rows);
}

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

export async function loadEnvVar(
  id: string,
  db: DbReader = getDb(),
): Promise<EnvVar | null> {
  const rows = await db
    .select()
    .from(envVars)
    .where(eq(envVars.id, id))
    .limit(1);
  const [e] = await assembleEnvVars(db, rows);
  return e ?? null;
}

export async function insertEnvVars(
  db: DbReader,
  vars: EnvVar[],
): Promise<void> {
  if (vars.length === 0) return;
  await db.insert(envVars).values(vars.map(envVarToRow));
  const targets = vars.flatMap(envVarTargetsToRows);
  if (targets.length > 0) await db.insert(envVarTargets).values(targets);
}

export function appScopeWhere(): SQL | undefined {
  const scope = narrowedScope();
  if (!scope) return undefined;
  const clauses: SQL[] = [];
  if (scope.projectIds.length > 0)
    clauses.push(inArray(apps.projectId, scope.projectIds));
  if (scope.folderIds.length > 0)
    clauses.push(inArray(apps.folderId, scope.folderIds));
  if (scope.appIds.length > 0) clauses.push(inArray(apps.id, scope.appIds));
  if (clauses.length === 0) return sql`false`;
  return clauses.length === 1 ? clauses[0] : or(...clauses)!;
}

export async function loadTeamApp(
  appId: string,
  teamId: string,
  db: DbReader = getDb(),
): Promise<App | null> {
  const p = await loadAppGraph(appId, db);
  return p && p.teamId === teamId && inAppScope(p) ? p : null;
}

export async function appSourceInTeam(
  appId: string,
  teamId: string,
  db: DbReader = getDb(),
): Promise<DeploySource | null> {
  const rows = await db
    .select({ source: apps.source })
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.teamId, teamId), appScopeWhere()))
    .limit(1);
  return (rows[0]?.source as DeploySource) ?? null;
}

export async function appInTeam(
  appId: string,
  teamId: string,
  db: DbReader = getDb(),
): Promise<boolean> {
  const rows = await db
    .select({ id: apps.id })
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.teamId, teamId), appScopeWhere()))
    .limit(1);
  return rows.length > 0;
}
