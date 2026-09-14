import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { deployments as deploymentsTable } from "../../db/schema/control-plane/deployments";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { requireActiveTeamId } from "../../membership";
import {
  repoCommitUrl,
  githubPullRequestUrl,
  gitProfileUrl,
} from "../../utils";
import { loadDeployment, appInTeam, appScopeWhere } from "../app-graph-load";
import { assembleDeployment } from "../app-graph-rows/deployment";
import { authorOf, loadUserIdentities } from "../user-identity";
import {
  appCapabilities,
  appCapabilitiesForTeam,
  nodeCapabilitiesFor,
} from "../node-access";
import { canRollbackTo, rollbackTargetIds } from "./rollback";
import { IN_PROGRESS } from "./cancel-and-delete";
import type { Deployment, DeploymentEnvironment } from "../../types/deployment";

export async function listDeployments(filter?: {
  appId?: string;
  environment?: DeploymentEnvironment;
  status?: Deployment["status"];
  // Bounds the nested GraphQL fan-out (App.deployments) so a small query can't
  // force loading every deployment.
  limit?: number;
}): Promise<
  (Deployment & {
    serviceName: string;
    appSlug: string;
    appLogo: string | null;
    commitUrl: string | null;
    pullRequestUrl: string | null;
    creatorUrl: string | null;
    serverId: string | null;
    serverName: string | null;
    buildServerName: string | null;
    // Decided HERE, never in the UI: whether an image is still on the host is a
    // server fact, and a client re-deriving it would drift from the gate.
    canRollback: boolean;
    appMigrating: boolean;
  })[]
> {
  const teamId = await requireActiveTeamId();
  const scopedApps = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      logo: appsTable.logo,
      migrationRunId: appsTable.migrationRunId,
      serverId: appsTable.serverId,
      rollbackKeep: appsTable.rollbackKeep,
      source: appsTable.source,
      compose: appsTable.compose,
      dockerImage: appsTable.dockerImage,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
      repoProvider: appsTable.repoProvider,
      repoRepo: appsTable.repoRepo,
      repoUrl: appsTable.repoUrl,
    })
    .from(appsTable)
    .where(and(eq(appsTable.teamId, teamId), appScopeWhere()));
  // A deployment names its app, its commit and its URL, so an app the caller
  // can't reach (one inside a folder they can't see) must not appear here either.
  const reach = await appCapabilitiesForTeam(
    teamId,
    scopedApps.map((p) => ({
      id: p.id,
      folderId: p.folderId ?? null,
      projectId: p.projectId ?? null,
      environmentId: p.environmentId ?? null,
    })),
  );
  // A narrowed principal is NOT exempt.
  const teamApps = scopedApps.filter((p) => (reach.get(p.id)?.length ?? 0) > 0);
  const byId = new Map(teamApps.map((p) => [p.id, p] as const));
  const appIds = filter?.appId
    ? byId.has(filter.appId)
      ? [filter.appId]
      : []
    : teamApps.map((p) => p.id);
  if (appIds.length === 0) return [];

  const base = getDb()
    .select()
    .from(deploymentsTable)
    .where(inArray(deploymentsTable.appId, appIds))
    .orderBy(desc(deploymentsTable.createdAt), desc(deploymentsTable.seq));
  // A page, never the whole history: every row can carry its own log.
  const rows = await base.limit(Math.min(filter?.limit ?? 200, 1000));

  const serverIds = [
    ...new Set(
      [
        ...rows.map((r) => r.serverId),
        ...rows.map((r) => r.buildServerId),
        ...teamApps.map((s) => s.serverId),
      ].filter((id): id is string => !!id),
    ),
  ];
  const serverNameById = new Map(
    serverIds.length === 0
      ? []
      : (
          await getDb()
            .select({ id: serversTable.id, name: serversTable.name })
            .from(serversTable)
            .where(inArray(serversTable.id, serverIds))
        ).map((s) => [s.id, s.name] as const),
  );

  const byApp = new Map<string, Deployment[]>();
  for (const row of rows) {
    const dep = assembleDeployment(row);
    const list = byApp.get(dep.appId);
    if (list) list.push(dep);
    else byApp.set(dep.appId, [dep]);
  }
  const rollbackable = new Set<string>();
  for (const p of teamApps) {
    for (const id of rollbackTargetIds(p, byApp.get(p.id) ?? [])) {
      rollbackable.add(id);
    }
  }

  const creators = await loadUserIdentities(rows.map((r) => r.creatorUserId));

  return rows
    .map((row) => ({ dep: assembleDeployment(row), rowServerId: row.serverId }))
    .filter(
      ({ dep }) =>
        !filter?.environment || dep.environment === filter.environment,
    )
    .filter(({ dep }) => !filter?.status || dep.status === filter.status)
    .map(({ dep, rowServerId }) => {
      const p = byId.get(dep.appId);
      const serverId = rowServerId ?? p?.serverId ?? null;
      return {
        ...dep,
        creatorUser: authorOf(dep.creatorUserId, creators),
        canRollback: rollbackable.has(dep.id),
        appMigrating: Boolean(p?.migrationRunId),
        serviceName: p?.name ?? "",
        appSlug: p?.slug ?? "",
        appLogo: p?.logo ?? null,
        serverId,
        serverName: serverId ? (serverNameById.get(serverId) ?? null) : null,
        buildServerName:
          dep.buildServerId && dep.buildServerId !== serverId
            ? (serverNameById.get(dep.buildServerId) ?? null)
            : null,
        commitUrl: repoCommitUrl(
          { provider: p?.repoProvider, repo: p?.repoRepo, url: p?.repoUrl },
          dep.commitSha,
        ),
        pullRequestUrl: githubPullRequestUrl(
          { provider: p?.repoProvider, repo: p?.repoRepo, url: p?.repoUrl },
          dep.prNumber,
        ),
        creatorUrl: gitProfileUrl(dep.creatorProvider, dep.creator, p?.repoUrl),
      };
    });
}

export async function getDeployment(
  id: string,
): Promise<(Deployment & { canRollback: boolean }) | null> {
  const teamId = await requireActiveTeamId();
  const dep = await loadDeployment(id);
  if (!dep) return null;
  if (!(await appInTeam(dep.appId, teamId))) return null;
  // Same answer for "no such deployment" and "not yours", so neither can be told
  // apart. A narrowed principal is not exempt, exactly as in `listDeployments`.
  if ((await appCapabilities(dep.appId)).length === 0) return null;
  const creators = await loadUserIdentities([dep.creatorUserId]);
  return {
    ...dep,
    creatorUser: authorOf(dep.creatorUserId, creators),
    canRollback: await canRollbackTo(dep),
  };
}

// isFirstDeployment says whether this is the app's first build ever.
export async function isFirstDeployment(dep: Deployment): Promise<boolean> {
  const [oldest] = await getDb()
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.appId, dep.appId))
    .orderBy(asc(deploymentsTable.createdAt), asc(deploymentsTable.seq))
    .limit(1);
  return oldest?.id === dep.id;
}

// countActiveDeploymentsForTeam counts queued/building deployments one member can reach.
export async function countActiveDeploymentsForTeam(
  teamId: string,
  userId: string,
): Promise<number> {
  const rows = await getDb()
    .select({ appId: deploymentsTable.appId })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(deploymentsTable.appId, appsTable.id))
    .where(
      and(
        eq(appsTable.teamId, teamId),
        appScopeWhere(),
        inArray(deploymentsTable.status, IN_PROGRESS),
      ),
    );
  // One reachability answer per DISTINCT app - two builds of one app ask once.
  const reachable = new Map<string, boolean>();
  let count = 0;
  for (const row of rows) {
    let ok = reachable.get(row.appId);
    if (ok === undefined) {
      ok =
        (
          await nodeCapabilitiesFor(userId, teamId, {
            kind: "app",
            id: row.appId,
          })
        ).length > 0;
      reachable.set(row.appId, ok);
    }
    if (ok) count++;
  }
  return count;
}
