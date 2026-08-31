import "server-only";

import { cache } from "react";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import { teamAvatarUrl } from "../avatar";
import {
  activities as activitiesTable,
  appEnvironments as appEnvironmentsTable,
  apps as appsTable,
  backups as backupsTable,
  backupRuns as backupRunsTable,
  apiTokenApps as apiTokenAppsTable,
  cronJobs as cronJobsTable,
  environments as environmentsTable,
  folders as foldersTable,
  gitConnections as gitConnectionsTable,
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projects as projectsTable,
  servers as serversTable,
  serverTeams as serverTeamsTable,
  sharedEnvVarApps as sharedEnvVarAppsTable,
  appGrants as appGrantsTable,
  teamAppOrder,
  teamRoleScopeApps,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { membershipFor, requireCapability } from "../membership";
import { currentIdentity } from "../auth/request-context";
import { recordActivity } from "./activity";
import { reapplyNetworkAfterMove } from "../deploy/build";
import { assertNoNameClash } from "./name-clash";
import { composeNamesOnNetwork } from "../deploy/compose-stack";
import { stackName } from "../deploy/deploy-key";
import { requireAppCapability } from "./node-access";
import { assertServerAccessibleTx } from "./servers";
import { withKeyedLock } from "./keyed-mutex";

/**
 * Transferring an App to another team - the Danger Zone action that hands a whole
 * app (its build config, variables, domains, deployments and volumes) to a
 * different team the SAME person belongs to.
 */

export interface AppTransferTarget {
  id: string;
  name: string;
  /** The team's picture, so the picker names it the way the switcher does. */
  avatarUrl: string | null;
  /**
   * False when the app's server is restricted and NOT shared with that team.
   * The transfer is refused (an app must stay on a host its team may target);
   * an instance admin opens the server up in Settings → Servers.
   */
  serverAvailable: boolean;
  /**
   * True when that team has its own GitHub App installed on the repository's
   * account, so the repository connection follows the app.
   */
  githubFollows: boolean;
}

export interface AppTransferInfo {
  appName: string;
  serverName: string;
  /** Where the app sits inside its current team ("folder Marketing"), or null at the top level. */
  homeLabel: string | null;
  /** Shared variables linked to this app - links that do not survive the move. */
  sharedVarCount: number;
  /** Backup schedules targeting this app - they point at the source team's destination. */
  backupCount: number;
  githubConnected: boolean;
  /**
   * The label of the git connection authenticating this app's clone, or null.
   * Unlike a GitHub installation it can never follow the app: a token for the same
   * host says nothing about whether it can read this repository.
   */
  gitConnectionLabel: string | null;
  /** Every OTHER team the viewer belongs to WITH `deploy`, alphabetical. */
  targets: AppTransferTarget[];
}

/** The owning GitHub account of `owner/name` (or of a repo URL), lowercased. */
function repoOwner(repo: string | null, url: string | null): string | null {
  const fromRepo = repo?.split("/")[0]?.trim();
  if (fromRepo) return fromRepo.toLowerCase();
  const path = url
    ?.replace(/^https?:\/\/[^/]+\//, "")
    .split("/")[0]
    ?.trim();
  return path ? path.toLowerCase() : null;
}

/** The app row every function here works from, team-scoped by the caller. */
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

/**
 * Everything the transfer dialog needs in ONE round trip: what the app is about to
 * lose, and which teams can take it.
 */
export const appTransferInfo = cache(
  async (appId: string): Promise<AppTransferInfo> => {
    // The APP's gate, not the team's - the same one `transferAppToTeam` below applies,
    // so what this screen shows and what the move allows agree.
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

    // Candidate teams: the viewer's OTHER memberships that carry `deploy` - the
    // "can manage apps there" bar, resolved from the capability junction (the
    // role name is only a preset, never the authority).
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

    // Which candidates could keep the repository connected - i.e. already have a
    // GitHub App installed on the SAME account as the app's repository.
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

/** "folder Marketing" / "project Shop (production)" / null at the top level. */
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

/**
 * Hand this app over to another team. On the DESTINATION side the bar is the one
 * the mission states: the viewer must belong to that team and hold `move_apps`
 * there (they must be able to manage apps where the app lands).
 */
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

  // A SCOPED API token must not move an app into a team outside its scope.
  const tokenScope = currentIdentity()?.token?.scope;
  if (tokenScope && !tokenScope.teamIds.includes(destTeamId))
    throw new Error("This API token can't move apps into that team.");

  const dest = await membershipFor(userId, destTeamId);
  if (!dest) throw new Error("You're not a member of that team");
  if (!dest.capabilities.includes("move_apps"))
    throw new Error("You don't have permission to manage apps in that team");
  const destTeam = (
    await db
      .select({ name: teamsTable.name })
      .from(teamsTable)
      .where(eq(teamsTable.id, destTeamId))
      .limit(1)
  )[0];
  if (!destTeam) throw new Error("Team not found");
  // It lands on the destination team's own network, where its service names may
  // already be taken - and Docker would split the lookups rather than complain.
  const [claimSource] = await db
    .select({ slug: appsTable.slug, compose: appsTable.compose })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  // The destination team's network, held for the check AND the write below.
  await assertNoNameClash({
    to: { teamId: destTeamId, environmentId: null, serverId: app.serverId },
    claims: claimSource?.compose?.trim()
      ? composeNamesOnNetwork(claimSource.compose)
      : [stackName(claimSource?.slug ?? "")],
    exceptId: appId,
    subject: "this app",
  });
  const sourceTeam = (
    await db
      .select({ name: teamsTable.name })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];

  // The app must land on a host the destination team may target - refuse with a
  // message that says who fixes it, rather than parking the app on a server it can't
  // reach.
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

  // The GitHub connection is a credential of the SOURCE team's GitHub App, so it may
  // not simply ride along.
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
  // A git connection is a token owned by the SOURCE team, so unlike the GitHub
  // installation it has no "same account" test that could let it follow: holding a
  // token for the same host says nothing about whether it can read this repo.
  const connectionDropped = Boolean(app.repoConnectionId);
  const githubDropped =
    Boolean(app.repoInstallationId) && installationId === null;

  // The app's lifecycle lock, the same one a deploy and a delete take, so the
  // hand-over can't interleave with a bring-up of the very stack it re-homes.
  await withKeyedLock(`app-lifecycle:${appId}`, async () => {
    await db.transaction(async (tx) => {
      await assertServerAccessibleTx(tx, app.serverId, destTeamId);
      await tx
        .update(appsTable)
        .set({
          teamId: destTeamId,
          // Folders, projects and environments belong to the SOURCE team: the app
          // lands at the destination's top level, exactly like a fresh app.
          folderId: null,
          projectId: null,
          environmentId: null,
          repoInstallationId: installationId,
          repoConnectionId: null,
          ...(githubDropped || connectionDropped ? { autoDeploy: false } : {}),
          updatedAt: nowIso(),
        })
        .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)));
      // Per-environment runtime state of environments it no longer lives in.
      await tx
        .delete(appEnvironmentsTable)
        .where(eq(appEnvironmentsTable.appId, appId));
      // Manual display order is per team; the app joins the destination's tail.
      await tx.delete(teamAppOrder).where(eq(teamAppOrder.appId, appId));
      // Per-node access is a fact about the SOURCE team, exactly like the folder and
      // project links cleared above.
      await tx.delete(appGrantsTable).where(eq(appGrantsTable.appId, appId));
      await tx
        .delete(teamRoleScopeApps)
        .where(eq(teamRoleScopeApps.appId, appId));
      // Shared variables stay with the team that owns them (ADR-0012: injection
      // is the per-app link and nothing else) - the links go, the values never
      // travel.
      await tx
        .delete(sharedEnvVarAppsTable)
        .where(eq(sharedEnvVarAppsTable.appId, appId));
      // Backup schedules point at the SOURCE team's backup destination, which the
      // destination team cannot see, read or rotate. The runs already taken stay
      // as that team's history (its destination, its audit trail).
      await tx
        .delete(backupsTable)
        .where(
          and(eq(backupsTable.appId, appId), eq(backupsTable.teamId, teamId)),
        );
      // Cron jobs carry BOTH team_id and app_id, like backups, and, like them, point at
      // the SOURCE team and run the SOURCE team's command in the container.
      await tx
        .delete(cronJobsTable)
        .where(
          and(eq(cronJobsTable.appId, appId), eq(cronJobsTable.teamId, teamId)),
        );
      // An API token SCOPED to this app is the source team's credential, and its reach is
      // derived live from `apps.teamId`, so a surviving row would follow the app into
      // the destination team and show up in ITS "tokens reaching this team" list without
      await tx
        .delete(apiTokenAppsTable)
        .where(eq(apiTokenAppsTable.appId, appId));
      // Their POINTER to the app goes, though, and that is not bookkeeping. They would
      // sit on the destination forever. Nulling it makes them ordinary orphans, which is
      // what they are, and the sweep reclaims them after the usual keep window.
      await tx
        .update(backupRunsTable)
        .set({ appId: null })
        .where(
          and(
            eq(backupRunsTable.appId, appId),
            eq(backupRunsTable.teamId, teamId),
          ),
        );
      // Keep the source team's log entries, drop the pointer: those rows must not
      // deep-link members into an app their team no longer owns.
      await tx
        .update(activitiesTable)
        .set({ appId: null })
        .where(eq(activitiesTable.appId, appId));
    });
  });

  // The app changed TEAM, so it changed network too - the destination's top level
  // is the destination team's own. Outside the transaction: it is an agent call.
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
