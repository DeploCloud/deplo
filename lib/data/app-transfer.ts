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
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projects as projectsTable,
  servers as serversTable,
  serverTeams as serverTeamsTable,
  sharedEnvVarApps as sharedEnvVarAppsTable,
  teamAppOrder,
  teams as teamsTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { nowIso } from "../ids";
import { membershipFor, requireCapability } from "../membership";
import { recordActivity } from "./activity";
import { requireAppCapability } from "./node-access";
import { assertServerAccessibleTx } from "./servers";
import { withKeyedLock } from "./keyed-mutex";

/**
 * Transferring an App to another team — the Danger Zone action that hands a
 * whole app (its build config, variables, domains, deployments and volumes) to
 * a different team the SAME person belongs to.
 *
 * Why it lives in its own module: an App is the only object with children on
 * both sides of the tenancy line. Everything hanging off `apps.id` (env vars,
 * domains, deployments, basic-auth users) is app-scoped and simply
 * follows the row, while a handful of records are attachments to the SOURCE
 * TEAM and cannot travel — its folders and projects, the shared variables it
 * links, its backup schedules (which point at that team's S3 destination), and
 * its GitHub App installation. Those are severed here, deliberately and
 * visibly, instead of being left as cross-team pointers.
 *
 * Two properties this file exists to guarantee:
 *
 *  - **Nothing of the source team leaks into the destination.** A credential
 *    the destination team does not own is never inherited: the GitHub
 *    connection only follows when the destination has its OWN installation on
 *    the repository's account, and otherwise it is dropped (auto-deploy with
 *    it).
 *  - **Nothing of the app stays pointing back.** The app leaves its folder /
 *    project / environment, its ordering rows and shared-variable links go, and
 *    the source team's activity rows stop pointing at an app it can no longer
 *    open.
 *
 * The running container is NOT touched: a stack is keyed by the app's slug, not
 * by its team, so a transfer never interrupts traffic. The severed variables
 * take effect on the next deploy — which is what the confirm dialog says.
 */

export interface AppTransferTarget {
  id: string;
  name: string;
  /**
   * False when the app's server is restricted and NOT shared with that team.
   * The transfer is refused (an app must stay on a host its team may target);
   * an instance admin opens the server up in Settings → Servers.
   */
  serverAvailable: boolean;
  /**
   * True when that team has its own GitHub App installed on the repository's
   * account, so the repository connection follows the app. False ⇒ the
   * connection is dropped on transfer and has to be reconnected there.
   * Meaningless (and always true) for an app with no GitHub connection.
   */
  githubFollows: boolean;
}

export interface AppTransferInfo {
  appName: string;
  serverName: string;
  /** Where the app sits inside its current team ("folder Marketing"), or null at the top level. */
  homeLabel: string | null;
  /** Shared variables linked to this app — links that do not survive the move. */
  sharedVarCount: number;
  /** Backup schedules targeting this app — they point at the source team's destination. */
  backupCount: number;
  githubConnected: boolean;
  /** Every OTHER team the viewer belongs to WITH `deploy`, alphabetical. */
  targets: AppTransferTarget[];
}

/** The owning GitHub account of `owner/name` (or of a repo URL), lowercased. */
function repoOwner(repo: string | null, url: string | null): string | null {
  const fromRepo = repo?.split("/")[0]?.trim();
  if (fromRepo) return fromRepo.toLowerCase();
  const path = url?.replace(/^https?:\/\/[^/]+\//, "").split("/")[0]?.trim();
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
  autoDeploy: appsTable.autoDeploy,
};

/**
 * Everything the transfer dialog needs in ONE round trip: what the app is about
 * to lose, and which teams can take it. Gated on `deploy` like the transfer
 * itself, so the team list is never a cross-team read for a passer-by — and it
 * only ever names teams the VIEWER already belongs to.
 */
export const appTransferInfo = cache(
  async (appId: string): Promise<AppTransferInfo> => {
    // The APP's gate, not the team's — the same one `transferAppToTeam` below
    // applies, so what this screen shows and what the move allows agree. Holding
    // team `move_apps` is not access to an app inside a folder you can't see,
    // and this DTO is the app's name, its server, its counts and — through
    // `homeLabel` — the name of that very folder.
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

    // Candidate teams: the viewer's OTHER memberships that carry `deploy` — the
    // "can manage apps there" bar, resolved from the capability junction (the
    // role name is only a preset, never the authority).
    const candidates = await db
      .select({ id: teamsTable.id, name: teamsTable.name })
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
        and(eq(membershipsTable.userId, userId), ne(membershipsTable.teamId, teamId)),
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

    // Which candidates could keep the repository connected — i.e. already have a
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
      targets: candidates.map((c) => ({
        id: c.id,
        name: c.name,
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
 * Hand this app over to another team.
 *
 * Authorization is deliberately stricter than delete on the SOURCE side: it
 * needs `deploy` AND `manage_env`, because the app carries its encrypted
 * variables across a tenancy boundary — without the second gate, a member who
 * may not read the team's secrets could move them into a team where they can.
 * On the DESTINATION side the bar is the one the mission states: the viewer must
 * belong to that team and hold `deploy` there (they must be able to manage apps
 * where the app lands). A folder-scoped app additionally needs both capabilities
 * on its folder, exactly like pulling it out of that folder.
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
  const sourceTeam = (
    await db
      .select({ name: teamsTable.name })
      .from(teamsTable)
      .where(eq(teamsTable.id, teamId))
      .limit(1)
  )[0];

  // The app must land on a host the destination team may target — refuse with a
  // message that says who fixes it, rather than parking the app on a server it
  // can't reach. (Re-checked inside the transaction against a concurrent
  // "restrict this server" write.)
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

  // The GitHub connection is a credential of the SOURCE team's GitHub App, so it
  // may not simply ride along. It follows only when the destination team has its
  // own installation on the same account; otherwise it is dropped, and with it
  // auto-deploy (which is driven by webhook deliveries for that installation and
  // would silently never fire again).
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
  const githubDropped = Boolean(app.repoInstallationId) && installationId === null;

  // The app's lifecycle lock — the same one a deploy and a delete take — so the
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
          ...(githubDropped ? { autoDeploy: false } : {}),
          updatedAt: nowIso(),
        })
        .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)));
      // Per-environment runtime state of environments it no longer lives in.
      await tx
        .delete(appEnvironmentsTable)
        .where(eq(appEnvironmentsTable.appId, appId));
      // Manual display order is per team; the app joins the destination's tail.
      await tx.delete(teamAppOrder).where(eq(teamAppOrder.appId, appId));
      // Shared variables stay with the team that owns them (ADR-0012: injection
      // is the per-app link and nothing else) — the links go, the values never
      // travel.
      await tx
        .delete(sharedEnvVarAppsTable)
        .where(eq(sharedEnvVarAppsTable.appId, appId));
      // Backup schedules point at the SOURCE team's S3 destination, which the
      // destination team cannot see, read or rotate. The runs already taken stay
      // as that team's history (its bucket, its audit trail).
      await tx
        .delete(backupsTable)
        .where(and(eq(backupsTable.appId, appId), eq(backupsTable.teamId, teamId)));
      // Keep the source team's log entries, drop the pointer: those rows must not
      // deep-link members into an app their team no longer owns.
      await tx
        .update(activitiesTable)
        .set({ appId: null })
        .where(eq(activitiesTable.appId, appId));
    });
  });

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
