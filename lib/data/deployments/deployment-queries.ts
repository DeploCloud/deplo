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
  const reach = await appCapabilitiesForTeam(
    teamId,
    scopedApps.map((p) => ({
      id: p.id,
      folderId: p.folderId ?? null,
      projectId: p.projectId ?? null,
      environmentId: p.environmentId ?? null,
    })),
  );
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
  if ((await appCapabilities(dep.appId)).length === 0) return null;
  const creators = await loadUserIdentities([dep.creatorUserId]);
  return {
    ...dep,
    creatorUser: authorOf(dep.creatorUserId, creators),
    canRollback: await canRollbackTo(dep),
  };
}

export async function isFirstDeployment(dep: Deployment): Promise<boolean> {
  const [oldest] = await getDb()
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.appId, dep.appId))
    .orderBy(asc(deploymentsTable.createdAt), asc(deploymentsTable.seq))
    .limit(1);
  return oldest?.id === dep.id;
}

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
