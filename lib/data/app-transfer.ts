import "server-only";

import { cache } from "@/lib/request-cache";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { teamAvatarUrl } from "../avatar";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  appGrants as appGrantsTable,
  teamRoleScopeApps,
} from "../db/schema/control-plane/access-control";
import { activities as activitiesTable } from "../db/schema/control-plane/activity";
import { apiTokenApps as apiTokenAppsTable } from "../db/schema/control-plane/api-tokens";
import {
  appEnvironments as appEnvironmentsTable,
  apps as appsTable,
} from "../db/schema/control-plane/apps";
import {
  backups as backupsTable,
  backupRuns as backupRunsTable,
} from "../db/schema/control-plane/backups";
import { cronJobs as cronJobsTable } from "../db/schema/control-plane/crons";
import { teamAppOrder } from "../db/schema/control-plane/display-order";
import { sharedEnvVarApps as sharedEnvVarAppsTable } from "../db/schema/control-plane/env-vars";
import { teams as teamsTable } from "../db/schema/control-plane/identity";
import {
  gitConnections as gitConnectionsTable,
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
} from "../db/schema/control-plane/integrations";
import {
  environments as environmentsTable,
  folders as foldersTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";
import {
  servers as serversTable,
  serverTeams as serverTeamsTable,
} from "../db/schema/control-plane/servers";
import { getCurrentUser } from "../auth/current-user";
import { nowIso } from "../ids";
import { holdsTeamWideCapability, membershipFor } from "../membership";
import { currentIdentity } from "../auth/request-context";
import { recordActivity } from "./activity";
import { reapplyNetworkAfterMove } from "../deploy/build/reroute";
import { assertNoNameClash, withNetworkLock } from "./name-clash";
import { composeNamesOnNetwork } from "../deploy/compose-stack/compose-read";
import { stackName } from "../deploy/deploy-key";
import { requireAppCapability } from "./node-access";
import { assertServerAccessibleTx } from "./servers/team-access";
import { withKeyedLock } from "./keyed-mutex";

export interface AppTransferTarget {
  id: string;
  name: string;
  avatarUrl: string | null;
  serverAvailable: boolean;
  githubFollows: boolean;
}

export interface AppTransferInfo {
  appName: string;
  serverName: string;
  homeLabel: string | null;
  sharedVarCount: number;
  backupCount: number;
  githubConnected: boolean;
  gitConnectionLabel: string | null;
  targets: AppTransferTarget[];
}

function repoOwner(repo: string | null, url: string | null): string | null {
  const fromRepo = repo?.split("/")[0]?.trim();
  if (fromRepo) return fromRepo.toLowerCase();
  const path = url
    ?.replace(/^https?:\/\/[^/]+\//, "")
    .split("/")[0]
    ?.trim();
  return path ? path.toLowerCase() : null;
}

const appColumns = {
  id: appsTable.id,
  name: appsTable.name,
  teamId: appsTable.teamId,
  serverId: appsTable.serverId,
  folderId: appsTable.folderId,
  projectId: appsTable.projectId,
  environmentId: appsTable.environmentId,
  repoRepo: appsTable.repoRepo,
  repoUrl: appsTable.repoUrl,
  repoInstallationId: appsTable.repoInstallationId,
  repoConnectionId: appsTable.repoConnectionId,
  autoDeploy: appsTable.autoDeploy,
};

export const appTransferInfo = cache(
  async (appId: string): Promise<AppTransferInfo> => {
    const { userId, teamId } = await requireAppCapability(appId, "move_apps");
    const db = getDb();
    const app = (
      await db
        .select(appColumns)
        .from(appsTable)
        .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
        .limit(1)
    )[0];
    if (!app) throw new Error("App not found");

    const candidates = await db
      .select({
        id: teamsTable.id,
        name: teamsTable.name,
        image: teamsTable.image,
      })
      .from(membershipsTable)
      .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
      .innerJoin(
        membershipCapabilitiesTable,
        and(
          eq(membershipCapabilitiesTable.membershipId, membershipsTable.id),
          eq(membershipCapabilitiesTable.capability, "move_apps"),
        ),
      )
      .where(
        and(
          eq(membershipsTable.userId, userId),
          ne(membershipsTable.teamId, teamId),
        ),
      )
      .orderBy(asc(teamsTable.name));
    const candidateIds = candidates.map((c) => c.id);

    const server = (
      await db
        .select({ name: serversTable.name, allTeams: serversTable.allTeams })
        .from(serversTable)
        .where(eq(serversTable.id, app.serverId))
        .limit(1)
    )[0];
    const serverTeamIds = server?.allTeams
      ? null
      : new Set(
          (
            await db
              .select({ teamId: serverTeamsTable.teamId })
              .from(serverTeamsTable)
              .where(eq(serverTeamsTable.serverId, app.serverId))
          ).map((r) => r.teamId),
        );

    const owner = repoOwner(app.repoRepo, app.repoUrl);
    const githubConnected = Boolean(app.repoInstallationId);
    const followTeams = new Set<string>();
    if (githubConnected && owner && candidateIds.length > 0) {
      const rows = await db
        .select({ teamId: githubAppsTable.teamId })
        .from(githubInstallationTable)
        .innerJoin(
          githubAppsTable,
          eq(githubAppsTable.id, githubInstallationTable.appId),
        )
        .where(
          and(
            inArray(githubAppsTable.teamId, candidateIds),
            sql`lower(${githubInstallationTable.accountLogin}) = ${owner}`,
          ),
        );
      for (const r of rows) followTeams.add(r.teamId);
    }

    const connectionLabel = app.repoConnectionId
      ? ((
          await db
            .select({ label: gitConnectionsTable.label })
            .from(gitConnectionsTable)
            .where(eq(gitConnectionsTable.id, app.repoConnectionId))
            .limit(1)
        )[0]?.label ?? null)
      : null;

    const [sharedVars, backups] = await Promise.all([
      db
        .select({ n: count() })
        .from(sharedEnvVarAppsTable)
        .where(eq(sharedEnvVarAppsTable.appId, appId)),
      db
        .select({ n: count() })
        .from(backupsTable)
        .where(eq(backupsTable.appId, appId)),
    ]);

    return {
      appName: app.name,
      serverName: server?.name ?? "its server",
      homeLabel: await homeLabelFor(app),
      sharedVarCount: Number(sharedVars[0]?.n ?? 0),
      backupCount: Number(backups[0]?.n ?? 0),
      githubConnected,
      gitConnectionLabel: connectionLabel,
      targets: candidates.map((c) => ({
        id: c.id,
        name: c.name,
        avatarUrl: teamAvatarUrl(c.image),
        serverAvailable: serverTeamIds ? serverTeamIds.has(c.id) : true,
        githubFollows: !githubConnected || followTeams.has(c.id),
      })),
    };
  },
);

async function homeLabelFor(app: {
  folderId: string | null;
  projectId: string | null;
  environmentId: string | null;
}): Promise<string | null> {
  const db = getDb();
  if (app.folderId) {
    const f = (
      await db
        .select({ name: foldersTable.name })
        .from(foldersTable)
        .where(eq(foldersTable.id, app.folderId))
        .limit(1)
    )[0];
    return f ? `folder ${f.name}` : null;
  }
  if (app.projectId) {
    const p = (
      await db
        .select({ name: projectsTable.name })
        .from(projectsTable)
        .where(eq(projectsTable.id, app.projectId))
        .limit(1)
    )[0];
    if (!p) return null;
    const e = app.environmentId
      ? (
          await db
            .select({ name: environmentsTable.name })
            .from(environmentsTable)
            .where(eq(environmentsTable.id, app.environmentId))
            .limit(1)
        )[0]
      : undefined;
    return e ? `project ${p.name} (${e.name})` : `project ${p.name}`;
  }
  return null;
}

export async function transferAppToTeam(
  appId: string,
  destTeamId: string,
): Promise<void> {
  const { userId, teamId } = await requireAppCapability(appId, "move_apps");
  await requireAppCapability(appId, "manage_env");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const db = getDb();

  const app = (
    await db
      .select(appColumns)
      .from(appsTable)
      .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
      .limit(1)
  )[0];
  if (!app) throw new Error("App not found");
  if (destTeamId === teamId)
    throw new Error("That app is already in this team");

  const tokenScope = currentIdentity()?.token?.scope;
  if (tokenScope && !tokenScope.wholeTeamIds.includes(destTeamId))
    throw new Error("This API token can't move apps into that team.");

  const dest = await membershipFor(userId, destTeamId);
  if (!dest) throw new Error("You're not a member of that team");
  if (!(await holdsTeamWideCapability(destTeamId, "move_apps")))
    throw new Error("You don't have permission to manage apps in that team");
  const destTeam = (
    await db
      .select({ name: teamsTable.name })
      .from(teamsTable)
      .where(eq(teamsTable.id, destTeamId))
      .limit(1)
  )[0];
  if (!destTeam) throw new Error("Team not found");
  const [claimSource] = await db
    .select({ slug: appsTable.slug, compose: appsTable.compose })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  const sourceTeam = (
    await db
      .select({ name: teamsTable.name })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];

  const server = (
    await db
      .select({ name: serversTable.name, allTeams: serversTable.allTeams })
      .from(serversTable)
      .where(eq(serversTable.id, app.serverId))
      .limit(1)
  )[0];
  if (server && !server.allTeams) {
    const granted = (
      await db
        .select({ teamId: serverTeamsTable.teamId })
        .from(serverTeamsTable)
        .where(
          and(
            eq(serverTeamsTable.serverId, app.serverId),
            eq(serverTeamsTable.teamId, destTeamId),
          ),
        )
        .limit(1)
    )[0];
    if (!granted)
      throw new Error(
        `${destTeam.name} can't use the server this app runs on (${server.name}). ` +
          `An instance admin can give that team access in Settings → Servers.`,
      );
  }

  let installationId = app.repoInstallationId;
  if (installationId) {
    const owner = repoOwner(app.repoRepo, app.repoUrl);
    const match = owner
      ? (
          await db
            .select({ id: githubInstallationTable.id })
            .from(githubInstallationTable)
            .innerJoin(
              githubAppsTable,
              eq(githubAppsTable.id, githubInstallationTable.appId),
            )
            .where(
              and(
                eq(githubAppsTable.teamId, destTeamId),
                sql`lower(${githubInstallationTable.accountLogin}) = ${owner}`,
              ),
            )
            .limit(1)
        )[0]
      : undefined;
    installationId = match?.id ?? null;
  }
  const connectionDropped = Boolean(app.repoConnectionId);
  const githubDropped =
    Boolean(app.repoInstallationId) && installationId === null;

  await withNetworkLock(
    { teamId: destTeamId, environmentId: null },
    async () => {
      await assertNoNameClash({
        to: { teamId: destTeamId, environmentId: null, serverId: app.serverId },
        claims: claimSource?.compose?.trim()
          ? composeNamesOnNetwork(claimSource.compose)
          : [stackName(claimSource?.slug ?? "")],
        exceptId: appId,
        subject: "this app",
      });
      await withKeyedLock(`app-lifecycle:${appId}`, async () => {
        await db.transaction(async (tx) => {
          await assertServerAccessibleTx(tx, app.serverId, destTeamId);
          await tx
            .update(appsTable)
            .set({
              teamId: destTeamId,
              folderId: null,
              projectId: null,
              environmentId: null,
              repoInstallationId: installationId,
              repoConnectionId: null,
              ...(githubDropped || connectionDropped
                ? { autoDeploy: false }
                : {}),
              updatedAt: nowIso(),
            })
            .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)));
          await tx
            .delete(appEnvironmentsTable)
            .where(eq(appEnvironmentsTable.appId, appId));
          await tx.delete(teamAppOrder).where(eq(teamAppOrder.appId, appId));
          await tx
            .delete(appGrantsTable)
            .where(eq(appGrantsTable.appId, appId));
          await tx
            .delete(teamRoleScopeApps)
            .where(eq(teamRoleScopeApps.appId, appId));
          await tx
            .delete(sharedEnvVarAppsTable)
            .where(eq(sharedEnvVarAppsTable.appId, appId));
          await tx
            .delete(backupsTable)
            .where(
              and(
                eq(backupsTable.appId, appId),
                eq(backupsTable.teamId, teamId),
              ),
            );
          await tx
            .delete(cronJobsTable)
            .where(
              and(
                eq(cronJobsTable.appId, appId),
                eq(cronJobsTable.teamId, teamId),
              ),
            );
          await tx
            .delete(apiTokenAppsTable)
            .where(eq(apiTokenAppsTable.appId, appId));
          await tx
            .update(backupRunsTable)
            .set({ appId: null })
            .where(
              and(
                eq(backupRunsTable.appId, appId),
                eq(backupRunsTable.teamId, teamId),
              ),
            );
          await tx
            .update(activitiesTable)
            .set({ appId: null })
            .where(eq(activitiesTable.appId, appId));
        });
      });
    },
  );

  await reapplyNetworkAfterMove([appId]);

  await recordActivity(
    "app",
    `Transferred ${app.name} to ${destTeam.name}`,
    userName,
    null,
    teamId,
  );
  await recordActivity(
    "app",
    `Received ${app.name} from ${sourceTeam?.name ?? "another team"}`,
    userName,
    appId,
    destTeamId,
  );
}
