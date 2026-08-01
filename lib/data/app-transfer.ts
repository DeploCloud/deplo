import "server-only";

import { cache } from "react";
import { and, asc, count, eq, inArray, ne, sql } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  activities as activitiesTable,
  appEnvironments as appEnvironmentsTable,
  apps as appsTable,
  backups as backupsTable,
  environments as environmentsTable,
  folders as foldersTable,
  githubApps as githubAppsTable,
  githubInstallation as githubInstallationTable,
  membershipCapabilities as membershipCapabilitiesTable,
  memberships as membershipsTable,
  projects as projectsTable,
  serverTeams as serverTeamsTable,
  servers as serversTable,
  sharedEnvVarApps as sharedEnvVarAppsTable,
  teamAppOrder,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { requireCapability } from "../membership";
import { requireFolderCapabilityForApp } from "./folder-access";
import { assertServerAccessibleTx } from "./servers";
import { withKeyedLock } from "./keyed-mutex";
import { recordActivity } from "./activity";

/**
 * Handing an App over to ANOTHER team (Settings → Advanced → Danger Zone).
 *
 * A transfer is a tenancy change, not a redeploy: every host-side artifact is
 * keyed by the app SLUG (container, volumes, files dir, Traefik routers — see
 * deploy-key.ts) and nothing rendered carries a team id, so the app keeps
 * serving the same URLs throughout. What moves is who owns, sees and may
 * operate it.
 *
 * Everything the app owns ALONE travels with it — deployments and their logs,
 * environment variables, domains, basic-auth users, volumes, resource limits.
 * Everything belonging to the SOURCE team is cut, because it cannot be read from
 * the other side of the tenancy boundary:
 *
 *  - its Folder / Project / Environment placement (those live in the old team):
 *    the app lands at the destination team's top level;
 *  - its shared-variable links (ADR-0012: a shared variable is a team asset, and
 *    injection is solely the per-app link);
 *  - its backup SCHEDULES — each points at an S3 destination the old team owns.
 *    Past runs stay behind as that team's history, and restoring one fails
 *    closed (it resolves the target team-scoped and no longer finds the app);
 *  - its GitHub connection, UNLESS the destination team has its OWN installation
 *    for the same account. The App credentials are team-owned: letting the new
 *    team inherit the old team's installation would hand them read access to
 *    every repository it covers.
 *
 * Both ends are gated. In the SOURCE team the caller needs `deploy` AND
 * `manage_env` — the app carries its secrets across, so whoever hands them to
 * another team must already be allowed to read them here — plus the same two on
 * the app's folder. In the DESTINATION team they need `deploy`, exactly what
 * creating an app there would take. The app's server must be targetable by that
 * team too, or the app would land on a host the team may not use.
 */

export interface AppTransferTarget {
  id: string;
  name: string;
  /** False ⇒ the app's server isn't shared with this team, so the move is refused. */
  serverAvailable: boolean;
  /**
   * True when the GitHub connection survives the move — this team owns an
   * installation for the repository's account. Always true for an app with no
   * GitHub connection (there is nothing to lose).
   */
  githubFollows: boolean;
}

export interface AppTransferInfo {
  /** The host the app runs on — named in the "not available to that team" refusal. */
  serverName: string;
  /** Where the app sits today ("folder Marketing", "project Shop / staging"), null at the top level. */
  homeLabel: string | null;
  sharedVarCount: number;
  backupCount: number;
  githubConnected: boolean;
  /** The viewer's OTHER teams where they hold `deploy`, by name. */
  targets: AppTransferTarget[];
}

interface TransferAppRow {
  id: string;
  name: string;
  slug: string;
  serverId: string;
  folderId: string | null;
  projectId: string | null;
  environmentId: string | null;
  repoRepo: string | null;
  repoUrl: string | null;
  repoInstallationId: string | null;
  autoDeploy: boolean;
}

/** The app, team-scoped — a foreign id gets the same "App not found" a stale one does. */
async function loadTransferApp(
  appId: string,
  teamId: string,
): Promise<TransferAppRow> {
  const rows = await getDb()
    .select({
      id: appsTable.id,
      name: appsTable.name,
      slug: appsTable.slug,
      serverId: appsTable.serverId,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
      repoRepo: appsTable.repoRepo,
      repoUrl: appsTable.repoUrl,
      repoInstallationId: appsTable.repoInstallationId,
      autoDeploy: appsTable.autoDeploy,
    })
    .from(appsTable)
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
    .limit(1);
  if (!rows[0]) throw new Error("App not found");
  return rows[0];
}

/**
 * The viewer's OTHER teams in which they hold `deploy` — the only teams that may
 * receive an app. ONE query against the capability junction: `membershipFor` per
 * team would be a round trip per row of a dropdown.
 */
async function transferCandidateTeams(
  userId: string,
  sourceTeamId: string,
): Promise<{ id: string; name: string }[]> {
  return getDb()
    .select({ id: teamsTable.id, name: teamsTable.name })
    .from(membershipsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .innerJoin(
      membershipCapabilitiesTable,
      and(
        eq(membershipCapabilitiesTable.membershipId, membershipsTable.id),
        eq(membershipCapabilitiesTable.capability, "deploy"),
      ),
    )
    .where(
      and(
        eq(membershipsTable.userId, userId),
        ne(membershipsTable.teamId, sourceTeamId),
      ),
    )
    .orderBy(asc(teamsTable.name));
}

/** Which of `teamIds` may target this server (`all_teams` ⇒ every one of them). */
async function teamsWithServerAccess(
  serverId: string,
  teamIds: string[],
): Promise<Set<string>> {
  if (teamIds.length === 0) return new Set();
  const server = await getDb()
    .select({ allTeams: serversTable.allTeams })
    .from(serversTable)
    .where(eq(serversTable.id, serverId))
    .limit(1);
  if (server[0]?.allTeams) return new Set(teamIds);
  const rows = await getDb()
    .select({ teamId: serverTeamsTable.teamId })
    .from(serverTeamsTable)
    .where(
      and(
        eq(serverTeamsTable.serverId, serverId),
        inArray(serverTeamsTable.teamId, teamIds),
      ),
    );
  return new Set(rows.map((r) => r.teamId));
}

/** The `owner` of an `owner/name` repo — how a GitHub installation is matched. */
function repoAccountLogin(app: TransferAppRow): string | null {
  const fromRepo = app.repoRepo?.split("/")[0]?.trim();
  if (fromRepo) return fromRepo;
  // Fall back to the clone URL for a row written before repo_repo was filled in.
  const m = app.repoUrl?.match(/github\.com[/:]+([^/]+)\//i);
  return m?.[1] ?? null;
}

/**
 * The installation owned by `teamId`'s OWN GitHub App that covers `accountLogin`
 * — what lets a git-connected app keep deploying after the move. Null when that
 * team has none for the account, in which case the connection is cut rather than
 * reused across the tenancy boundary.
 */
async function installationForTeam(
  teamId: string,
  accountLogin: string,
): Promise<string | null> {
  const rows = await getDb()
    .select({ id: githubInstallationTable.id })
    .from(githubInstallationTable)
    .innerJoin(
      githubAppsTable,
      eq(githubAppsTable.id, githubInstallationTable.appId),
    )
    .where(
      and(
        eq(githubAppsTable.teamId, teamId),
        sql`lower(${githubInstallationTable.accountLogin}) = lower(${accountLogin})`,
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/** "folder Marketing" / "project Shop / staging" / null at the top level. */
async function homeLabelFor(app: TransferAppRow): Promise<string | null> {
  if (app.folderId) {
    const f = await getDb()
      .select({ name: foldersTable.name })
      .from(foldersTable)
      .where(eq(foldersTable.id, app.folderId))
      .limit(1);
    return f[0] ? `folder ${f[0].name}` : null;
  }
  if (!app.projectId) return null;
  const p = await getDb()
    .select({ name: projectsTable.name })
    .from(projectsTable)
    .where(eq(projectsTable.id, app.projectId))
    .limit(1);
  if (!p[0]) return null;
  if (!app.environmentId) return `project ${p[0].name}`;
  const e = await getDb()
    .select({ name: environmentsTable.name })
    .from(environmentsTable)
    .where(eq(environmentsTable.id, app.environmentId))
    .limit(1);
  return e[0] ? `project ${p[0].name} / ${e[0].name}` : `project ${p[0].name}`;
}

/**
 * Everything the transfer dialog needs in ONE round trip: where the app may go,
 * and exactly what it loses on the way. Gated like the transfer itself, so the
 * query can't be used to enumerate a viewer's teams from an app they may not
 * hand over.
 */
export const appTransferInfo = cache(
  async (appId: string): Promise<AppTransferInfo> => {
    const { userId, teamId } = await requireCapability("deploy");
    await requireCapability("manage_env");
    const app = await loadTransferApp(appId, teamId);
    await requireFolderCapabilityForApp(appId, "deploy");

    const db = getDb();
    const [candidates, serverRow, sharedVars, backups, homeLabel] =
      await Promise.all([
        transferCandidateTeams(userId, teamId),
        db
          .select({ name: serversTable.name })
          .from(serversTable)
          .where(eq(serversTable.id, app.serverId))
          .limit(1),
        db
          .select({ n: count() })
          .from(sharedEnvVarAppsTable)
          .where(eq(sharedEnvVarAppsTable.appId, appId)),
        db
          .select({ n: count() })
          .from(backupsTable)
          .where(eq(backupsTable.appId, appId)),
        homeLabelFor(app),
      ]);

    const withServer = await teamsWithServerAccess(
      app.serverId,
      candidates.map((t) => t.id),
    );
    // Only asked when there IS a connection to lose.
    const account = app.repoInstallationId ? repoAccountLogin(app) : null;
    const followers = new Set<string>();
    if (account) {
      for (const t of candidates) {
        if (await installationForTeam(t.id, account)) followers.add(t.id);
      }
    }

    return {
      serverName: serverRow[0]?.name ?? "its server",
      homeLabel,
      sharedVarCount: Number(sharedVars[0]?.n ?? 0),
      backupCount: Number(backups[0]?.n ?? 0),
      githubConnected: Boolean(app.repoInstallationId),
      targets: candidates.map((t) => ({
        id: t.id,
        name: t.name,
        serverAvailable: withServer.has(t.id),
        githubFollows: !account || followers.has(t.id),
      })),
    };
  },
);

/**
 * Hand the app over to `destTeamId`. Irreversible from this side: once it lands,
 * only the destination team can transfer it back.
 *
 * The running stack is NOT touched (same slug ⇒ same containers, volumes and
 * routers), so the app keeps serving on its existing URLs. The cuts described at
 * the top of this file land in the records immediately, and in the rendered
 * stack on the app's next deploy.
 */
export async function transferAppToTeam(
  appId: string,
  destTeamId: string,
): Promise<void> {
  // `manage_env` on top of `deploy`: the app carries its secrets across a tenancy
  // boundary, so handing it over may not be cheaper than reading them here.
  const { userId, teamId } = await requireCapability("deploy");
  await requireCapability("manage_env");
  const userName = (await getCurrentUser())?.name ?? "Someone";
  const app = await loadTransferApp(appId, teamId);
  if (destTeamId === teamId) throw new Error("That app is already in this team.");
  // Folder gates run BEFORE the transaction: they query on their own connection,
  // which deadlocks inside an open one.
  await requireFolderCapabilityForApp(appId, "deploy");
  await requireFolderCapabilityForApp(appId, "manage_env");

  // The destination must be a team the CALLER belongs to and can deploy in —
  // resolved from the same query the picker is built from, so the UI and the
  // gate can never disagree.
  const candidates = await transferCandidateTeams(userId, teamId);
  const dest = candidates.find((t) => t.id === destTeamId);
  if (!dest)
    throw new Error(
      "You can only transfer an app to a team you belong to and can deploy in.",
    );

  const sourceTeam = (
    await getDb()
      .select({ name: teamsTable.name })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];

  // The GitHub App is team-owned, so the connection follows only when the
  // destination has its OWN installation for the repo's account. Otherwise it is
  // cut — with auto-deploy, which cannot fire without it.
  const account = app.repoInstallationId ? repoAccountLogin(app) : null;
  const nextInstallationId = account
    ? await installationForTeam(destTeamId, account)
    : app.repoInstallationId;
  const githubCut = Boolean(app.repoInstallationId) && !nextInstallationId;

  // The app's lifecycle lock (the same one a deploy's bring-up and a delete's
  // teardown take): the tenancy flip is serialized against them rather than
  // landing halfway through one.
  await withKeyedLock(`app-lifecycle:${appId}`, async () => {
    await getDb().transaction(async (tx) => {
      // Re-assert server access INSIDE the write (it share-locks the server row)
      // so a concurrent "restrict this server to these teams" can't be raced.
      await assertServerAccessibleTx(tx, app.serverId, destTeamId);
      const moved = await tx
        .update(appsTable)
        .set({
          teamId: destTeamId,
          // Folders, projects and environments belong to the OLD team: the app
          // lands at the destination's top level.
          folderId: null,
          projectId: null,
          environmentId: null,
          repoInstallationId: nextInstallationId,
          ...(githubCut ? { autoDeploy: false } : {}),
          updatedAt: nowIso(),
        })
        .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
        .returning({ id: appsTable.id });
      if (moved.length === 0) throw new Error("App not found");

      // Per-environment runtime state for environments the app just left.
      await tx
        .delete(appEnvironmentsTable)
        .where(eq(appEnvironmentsTable.appId, appId));
      // The old team's manual Overview order. Not re-inserted on the other side:
      // the junction is a PARTIAL order and an unlisted app sorts newest-first.
      await tx.delete(teamAppOrder).where(eq(teamAppOrder.appId, appId));
      // Shared variables are team assets — their links can't cross with the app.
      await tx
        .delete(sharedEnvVarAppsTable)
        .where(eq(sharedEnvVarAppsTable.appId, appId));
      // Backup SCHEDULES point at an S3 destination the old team owns. Past runs
      // stay behind as that team's history.
      await tx.delete(backupsTable).where(eq(backupsTable.appId, appId));
      // Keep the old team's activity text, drop the pointer into an app they can
      // no longer open.
      await tx
        .update(activitiesTable)
        .set({ appId: null })
        .where(eq(activitiesTable.appId, appId));
    });
  });

  // Outside the transaction (recordActivity opens its own connection). One row
  // per side: the source keeps the audit trail, the destination sees the arrival
  // on the app's own Activity.
  await recordActivity(
    "app",
    `Transferred ${app.name} to ${dest.name}`,
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
