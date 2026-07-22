import "server-only";

import { and, count, eq, inArray, or } from "drizzle-orm";
import { getDb, type DbTx } from "../db/client";
import {
  apiTokens as apiTokensTable,
  apps as appsTable,
  databases as databasesTable,
  folders as foldersTable,
  installedPlugins as installedPluginsTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projects as projectsTable,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { requireInstanceAdmin } from "../membership";
import { recordActivity } from "./activity";
import { instanceOwnerUserId } from "./instance-owner";
import { pluginSlug } from "../plugins/runtime";
import { teardownTeamResources, type TeardownPlan } from "./team-delete";
import type { Capability } from "../types";

/**
 * PERMANENTLY deleting a user account — the counterpart to suspending one, and
 * the only path in the product that removes a `users` row.
 *
 * The hard part is not the row, it is everything hanging off it. Three of the
 * user's belongings are NOT covered by any FK rule, because the safe default and
 * the operator's intent differ per instance:
 *
 *  - **Teams they are the ONLY member of.** Always deleted, never optional: a
 *    memberless team is unreachable (every read resolves through a membership),
 *    so leaving it behind would strand its apps, databases and volumes running
 *    forever with no UI able to show, stop or bill them. This is disclosed up
 *    front — {@link getDeleteUserImpact} names each such team with its exact app
 *    and database counts — rather than discovered afterwards.
 *  - **Teams they founded that still have other members.** Opt-in: those people
 *    are still working in there.
 *  - **The apps they created / the folders and Projects they own inside teams
 *    that survive.** Opt-in, because "this person left" and "everything they
 *    built must go" are different decisions.
 *
 * Everything else the FKs already answer correctly and this module leaves alone:
 * memberships, folder/Project grants and API tokens CASCADE; the crown
 * (`teams.founder_user_id`), folder/Project ownership and every authorship
 * column go `SET NULL`. Activity is deliberately untouched — `activities` is an
 * append-only audit log whose `actor_user_id` is NOT an FK precisely so that
 * deleting a user cannot rewrite history (see the table's own comment); entries
 * keep the name they were written with and simply stop resolving to an account.
 *
 * Lives in its own module (not members.ts) for the same reason team-delete does:
 * it pulls in the app-graph/agent teardown path, and members.ts stays light.
 */

/** A team touched by the deletion, with what deleting it would take down. */
export interface DeleteUserTeamImpact {
  teamId: string;
  name: string;
  appCount: number;
  databaseCount: number;
  /** Members other than the user being deleted. */
  otherMemberCount: number;
}

/** What deleting one account would actually do, computed before anything runs. */
export interface DeleteUserImpact {
  userId: string;
  username: string;
  name: string;
  /** Non-null ⇒ this account can't be deleted at all; the reason to show. */
  blockedReason: string | null;
  /** Teams where they are the ONLY member — always deleted with the account. */
  soloTeams: DeleteUserTeamImpact[];
  /** Teams they founded that still have other members — deleted only on request. */
  foundedTeams: DeleteUserTeamImpact[];
  /** Teams they merely belong to: those keep everything, minus this membership. */
  keptTeams: { teamId: string; name: string }[];
  /** Apps they created that live in a team which SURVIVES — deleted on request. */
  createdAppCount: number;
  /** Folders/Projects they own in a surviving team — deleted on request. */
  ownedFolderCount: number;
  ownedProjectCount: number;
  /** Apps sitting directly inside those folders/Projects (may overlap the above). */
  ownedAppCount: number;
  /** API tokens they minted — always revoked with the account. */
  tokenCount: number;
  /**
   * Surviving teams that would be left with nobody able to manage members or the
   * team. The delete heals them (the longest-standing remaining member inherits
   * the capability) — this list exists so the operator is told, not surprised.
   */
  vacatedTeams: string[];
}

/** The three "go deeper" choices the delete dialog offers. */
export interface DeleteUserOptions {
  /** Delete the apps they created inside teams that survive the deletion. */
  deleteCreatedApps: boolean;
  /** Delete the folders + Projects they own, and the apps inside them. */
  deleteOwnedWorkspaces: boolean;
  /** Delete the teams they founded that still have other members. */
  deleteFoundedTeams: boolean;
}

/** What a completed deletion actually removed, for the confirmation toast. */
export interface DeleteUserResult {
  username: string;
  teamsDeleted: number;
  appsDeleted: number;
  databasesDeleted: number;
}

// A team must never be left with zero holders of these — that locks it out of
// member/team management irrecoverably (same set as `members.ts`, which enforces
// it for removeMember; a cascaded membership can't be caught there).
const CRITICAL_CAPABILITIES: Capability[] = ["manage_members", "manage_team"];

/* ------------------------------------------------------------------ */
/* Shared resolution (used by both the preview and the delete)         */
/* ------------------------------------------------------------------ */

interface TeamShape {
  teamId: string;
  name: string;
  slug: string;
  memberCount: number;
  isMember: boolean;
  isFounder: boolean;
}

/**
 * Every team the user belongs to OR founded, with the two facts that decide its
 * fate: how many members it has, and whether they hold its crown.
 */
async function teamsAroundUser(
  db: DbTx | ReturnType<typeof getDb>,
  userId: string,
): Promise<TeamShape[]> {
  const rows = await db
    .select({
      teamId: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
      founderUserId: teamsTable.founderUserId,
      membershipUserId: membershipsTable.userId,
    })
    .from(teamsTable)
    .leftJoin(
      membershipsTable,
      and(
        eq(membershipsTable.teamId, teamsTable.id),
        eq(membershipsTable.userId, userId),
      ),
    )
    .where(
      or(
        eq(teamsTable.founderUserId, userId),
        eq(membershipsTable.userId, userId),
      ),
    );
  if (rows.length === 0) return [];
  const counts = await db
    .select({ teamId: membershipsTable.teamId, n: count() })
    .from(membershipsTable)
    .where(
      inArray(
        membershipsTable.teamId,
        rows.map((r) => r.teamId),
      ),
    )
    .groupBy(membershipsTable.teamId);
  const byTeam = new Map(counts.map((c) => [c.teamId, Number(c.n)]));
  return rows.map((r) => ({
    teamId: r.teamId,
    name: r.name,
    slug: r.slug,
    memberCount: byTeam.get(r.teamId) ?? 0,
    isMember: r.membershipUserId !== null,
    isFounder: r.founderUserId === userId,
  }));
}

/**
 * A team dies with the account when the user is its ONLY member — nobody is left
 * who could ever open it again. Founded teams that still have other members are
 * a separate, opt-in bucket.
 */
function isSoloTeam(t: TeamShape): boolean {
  return t.isMember && t.memberCount <= 1;
}

/** Per-team app + database counts, in one query each. */
async function countsByTeam(
  db: DbTx | ReturnType<typeof getDb>,
  teamIds: string[],
): Promise<{ apps: Map<string, number>; databases: Map<string, number> }> {
  if (teamIds.length === 0) return { apps: new Map(), databases: new Map() };
  const appRows = await db
    .select({ teamId: appsTable.teamId, n: count() })
    .from(appsTable)
    .where(inArray(appsTable.teamId, teamIds))
    .groupBy(appsTable.teamId);
  const dbRows = await db
    .select({ teamId: databasesTable.teamId, n: count() })
    .from(databasesTable)
    .where(inArray(databasesTable.teamId, teamIds))
    .groupBy(databasesTable.teamId);
  return {
    apps: new Map(appRows.map((r) => [r.teamId, Number(r.n)])),
    databases: new Map(dbRows.map((r) => [r.teamId, Number(r.n)])),
  };
}

/**
 * Why this account can't be deleted, or null. Two accounts are off limits and
 * both for the same reason the UI can act on: there is a correct move to make
 * first (log in as someone else / transfer the crown).
 */
async function blockedReasonFor(
  userId: string,
  actingUserId: string,
  tx?: DbTx,
): Promise<string | null> {
  if (userId === actingUserId)
    return "You can't delete your own account. Ask another instance admin to do it.";
  // Inside the delete's transaction the crown is read under the same locks as
  // the write it vetoes, so a concurrent transferInstanceOwner can't slip past.
  const owner = await instanceOwnerUserId(tx);
  if (owner !== null && owner === userId)
    return "The instance owner's account can't be deleted. Transfer ownership first.";
  return null;
}

/* ------------------------------------------------------------------ */
/* Preview                                                             */
/* ------------------------------------------------------------------ */

/**
 * Exactly what deleting `userId` would take with it — computed live, so the
 * dialog states facts ("2 apps, 1 database") instead of warning in the abstract.
 * Read-only and instance-admin gated, like the rest of the Users tab.
 */
export async function getDeleteUserImpact(
  userId: string,
): Promise<DeleteUserImpact> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  const db = getDb();
  const target = (
    await db
      .select({
        id: usersTable.id,
        username: usersTable.username,
        name: usersTable.name,
      })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1)
  )[0];
  if (!target) throw new Error("User not found");

  const teams = await teamsAroundUser(db, userId);
  const solo = teams.filter(isSoloTeam);
  const founded = teams.filter((t) => t.isFounder && !isSoloTeam(t));
  const kept = teams.filter((t) => !isSoloTeam(t) && !t.isFounder);
  const { apps, databases } = await countsByTeam(
    db,
    [...solo, ...founded].map((t) => t.teamId),
  );
  const shape = (t: TeamShape): DeleteUserTeamImpact => ({
    teamId: t.teamId,
    name: t.name,
    appCount: apps.get(t.teamId) ?? 0,
    databaseCount: databases.get(t.teamId) ?? 0,
    otherMemberCount: Math.max(0, t.memberCount - (t.isMember ? 1 : 0)),
  });

  // Counts for the opt-in checkboxes are scoped to teams that SURVIVE: whatever
  // sits in a solo team is already accounted for by that team's line above, and
  // counting it twice would read as double the damage.
  const survivingTeamIds = teams
    .filter((t) => !isSoloTeam(t))
    .map((t) => t.teamId);
  const ownedFolders = await ownedFolderIds(db, userId, survivingTeamIds);
  const ownedProjects = await ownedProjectIds(db, userId, survivingTeamIds);

  const tokens = await db
    .select({ n: count() })
    .from(apiTokensTable)
    .where(eq(apiTokensTable.userId, userId));

  return {
    userId: target.id,
    username: target.username,
    name: target.name,
    blockedReason: await blockedReasonFor(userId, actingUserId),
    soloTeams: solo.map(shape),
    foundedTeams: founded.map(shape),
    keptTeams: kept.map((t) => ({ teamId: t.teamId, name: t.name })),
    createdAppCount: (
      await createdAppRows(db, userId, survivingTeamIds)
    ).length,
    ownedFolderCount: ownedFolders.length,
    ownedProjectCount: ownedProjects.length,
    ownedAppCount: (
      await appsInWorkspaces(db, ownedFolders, ownedProjects, survivingTeamIds)
    ).length,
    tokenCount: Number(tokens[0]?.n ?? 0),
    vacatedTeams: await vacatedTeamNames(db, userId, survivingTeamIds),
  };
}

/** Folders the user owns inside the given teams. */
async function ownedFolderIds(
  db: DbTx | ReturnType<typeof getDb>,
  userId: string,
  teamIds: string[],
): Promise<string[]> {
  if (teamIds.length === 0) return [];
  const rows = await db
    .select({ id: foldersTable.id })
    .from(foldersTable)
    .where(
      and(
        eq(foldersTable.ownerUserId, userId),
        inArray(foldersTable.teamId, teamIds),
      ),
    );
  return rows.map((r) => r.id);
}

/** Project containers the user owns inside the given teams. */
async function ownedProjectIds(
  db: DbTx | ReturnType<typeof getDb>,
  userId: string,
  teamIds: string[],
): Promise<string[]> {
  if (teamIds.length === 0) return [];
  const rows = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(
      and(
        eq(projectsTable.ownerUserId, userId),
        inArray(projectsTable.teamId, teamIds),
      ),
    );
  return rows.map((r) => r.id);
}

/** The teardown-shaped rows for apps the user created in the given teams. */
async function createdAppRows(
  db: DbTx | ReturnType<typeof getDb>,
  userId: string,
  teamIds: string[],
): Promise<{ id: string; slug: string; serverId: string }[]> {
  if (teamIds.length === 0) return [];
  return db
    .select({
      id: appsTable.id,
      slug: appsTable.slug,
      serverId: appsTable.serverId,
    })
    .from(appsTable)
    .where(
      and(
        eq(appsTable.createdByUserId, userId),
        inArray(appsTable.teamId, teamIds),
      ),
    );
}

/** The teardown-shaped rows for apps sitting inside the given folders/Projects. */
async function appsInWorkspaces(
  db: DbTx | ReturnType<typeof getDb>,
  folderIds: string[],
  projectIds: string[],
  teamIds: string[],
): Promise<{ id: string; slug: string; serverId: string }[]> {
  if (teamIds.length === 0) return [];
  if (folderIds.length === 0 && projectIds.length === 0) return [];
  const scopes = [
    folderIds.length > 0 ? inArray(appsTable.folderId, folderIds) : undefined,
    projectIds.length > 0 ? inArray(appsTable.projectId, projectIds) : undefined,
  ].filter((c) => c !== undefined);
  return db
    .select({
      id: appsTable.id,
      slug: appsTable.slug,
      serverId: appsTable.serverId,
    })
    .from(appsTable)
    .where(and(inArray(appsTable.teamId, teamIds), or(...scopes)));
}

/**
 * Surviving teams where the user is the LAST holder of a critical capability.
 * Same question the delete asks after the fact — asked here so the dialog can
 * say who is about to inherit the keys.
 */
async function vacatedTeamNames(
  db: DbTx | ReturnType<typeof getDb>,
  userId: string,
  teamIds: string[],
): Promise<string[]> {
  if (teamIds.length === 0) return [];
  const names: string[] = [];
  for (const teamId of teamIds) {
    let vacated = false;
    for (const cap of CRITICAL_CAPABILITIES) {
      const holders = await capabilityHolders(db, teamId, cap);
      // Exactly the condition the heal fires on: nobody left holding it once
      // this account is gone.
      if (holders.filter((h) => h !== userId).length === 0) vacated = true;
    }
    if (vacated) {
      const team = (
        await db
          .select({ name: teamsTable.name })
          .from(teamsTable)
          .where(eq(teamsTable.id, teamId))
          .limit(1)
      )[0];
      if (team) names.push(team.name);
    }
  }
  return names;
}

/** The user ids holding `cap` in `teamId`. */
async function capabilityHolders(
  db: DbTx | ReturnType<typeof getDb>,
  teamId: string,
  cap: Capability,
): Promise<string[]> {
  const rows = await db
    .select({ userId: membershipsTable.userId })
    .from(membershipsTable)
    .innerJoin(
      membershipCapabilitiesTable,
      eq(membershipCapabilitiesTable.membershipId, membershipsTable.id),
    )
    .where(
      and(
        eq(membershipsTable.teamId, teamId),
        eq(membershipCapabilitiesTable.capability, cap),
      ),
    );
  return rows.map((r) => r.userId);
}

/* ------------------------------------------------------------------ */
/* Delete                                                              */
/* ------------------------------------------------------------------ */

/**
 * Permanently delete a user account, plus whatever the operator opted into.
 *
 * Everything is decided and snapshotted INSIDE one transaction — the row reads,
 * the guards and the deletes — so an app created (or a member added) while the
 * dialog was open is caught by the same statement that removes it. The agent
 * teardown then runs detached from that transaction and from the request, as it
 * does for a team delete: gRPC never happens inside a transaction, and a
 * multi-host fan-out outlives any sane HTTP timeout.
 */
export async function deleteUser(
  userId: string,
  options: DeleteUserOptions,
): Promise<DeleteUserResult> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  const actor = (await getCurrentUser())!;

  const { result, plan, healedTeams } = await getDb().transaction(async (tx) => {
    const target = (
      await tx
        .select({ id: usersTable.id, username: usersTable.username })
        .from(usersTable)
        .where(eq(usersTable.id, userId))
        .for("update")
        .limit(1)
    )[0];
    if (!target) throw new Error("User not found");

    const blocked = await blockedReasonFor(userId, actingUserId, tx);
    if (blocked) throw new Error(blocked);

    // No "keep one active admin" check is needed here, unlike `updateUserAdmin`:
    // the caller passed `requireInstanceAdmin` (so they ARE an active instance
    // admin — a suspended account can't authenticate at all) and cannot be the
    // target (blocked above), so an active admin always survives this delete by
    // construction.

    const teams = await teamsAroundUser(tx, userId);
    const teamsToDelete = teams.filter(
      (t) => isSoloTeam(t) || (options.deleteFoundedTeams && t.isFounder),
    );
    const deletedTeamIds = teamsToDelete.map((t) => t.teamId);
    const survivingTeamIds = teams
      .filter((t) => !deletedTeamIds.includes(t.teamId))
      .map((t) => t.teamId);

    // ---- snapshot the stacks that lose their records in this transaction ----
    const teamApps = deletedTeamIds.length
      ? await tx
          .select({
            id: appsTable.id,
            slug: appsTable.slug,
            serverId: appsTable.serverId,
          })
          .from(appsTable)
          .where(inArray(appsTable.teamId, deletedTeamIds))
      : [];
    const teamDatabases = deletedTeamIds.length
      ? await tx
          .select({
            id: databasesTable.id,
            host: databasesTable.host,
            serverId: databasesTable.serverId,
          })
          .from(databasesTable)
          .where(inArray(databasesTable.teamId, deletedTeamIds))
      : [];
    const teamPlugins = deletedTeamIds.length
      ? await tx
          .select({
            slug: installedPluginsTable.slug,
            catalogId: installedPluginsTable.catalogId,
            teamId: installedPluginsTable.teamId,
          })
          .from(installedPluginsTable)
          .where(inArray(installedPluginsTable.teamId, deletedTeamIds))
      : [];
    const teamSlugById = new Map(teamsToDelete.map((t) => [t.teamId, t.slug]));

    const ownedFolders = options.deleteOwnedWorkspaces
      ? await ownedFolderIds(tx, userId, survivingTeamIds)
      : [];
    const ownedProjects = options.deleteOwnedWorkspaces
      ? await ownedProjectIds(tx, userId, survivingTeamIds)
      : [];
    // Individually deleted apps: the ones they created (if asked) plus the ones
    // living in a folder/Project they own (if asked). De-duplicated by id — the
    // two sets overlap for anyone who works inside their own folder.
    const looseApps = new Map<string, { id: string; slug: string; serverId: string }>();
    if (options.deleteCreatedApps)
      for (const a of await createdAppRows(tx, userId, survivingTeamIds))
        looseApps.set(a.id, a);
    for (const a of await appsInWorkspaces(
      tx,
      ownedFolders,
      ownedProjects,
      survivingTeamIds,
    ))
      looseApps.set(a.id, a);

    // ---- the writes ----
    if (looseApps.size > 0)
      await tx.delete(appsTable).where(inArray(appsTable.id, [...looseApps.keys()]));
    // After their apps are gone: an owned folder/Project row is dropped outright
    // (its child folders re-parent to the team root via the FK's SET NULL, and
    // any app someone ELSE put inside orphans to the root rather than dying).
    if (ownedFolders.length > 0)
      await tx.delete(foldersTable).where(inArray(foldersTable.id, ownedFolders));
    if (ownedProjects.length > 0)
      await tx.delete(projectsTable).where(inArray(projectsTable.id, ownedProjects));
    // One DELETE per team — the FK CASCADEs drop everything team-scoped, exactly
    // as deleteTeam does.
    if (deletedTeamIds.length > 0)
      await tx.delete(teamsTable).where(inArray(teamsTable.id, deletedTeamIds));
    // The account itself: memberships, folder/Project grants and API tokens
    // CASCADE; the crown, folder/Project ownership and every authorship column
    // go SET NULL.
    await tx.delete(usersTable).where(eq(usersTable.id, userId));

    const healed = await healCriticalCapabilities(tx, survivingTeamIds);

    return {
      healedTeams: healed.map(
        (id) => teams.find((t) => t.teamId === id)?.name ?? id,
      ),
      result: {
        username: target.username,
        teamsDeleted: deletedTeamIds.length,
        appsDeleted: teamApps.length + looseApps.size,
        databasesDeleted: teamDatabases.length,
      },
      plan: {
        services: [...teamApps, ...looseApps.values()],
        databases: teamDatabases,
        appSlugs: teamPlugins.map(
          (p) => p.slug || pluginSlug(p.catalogId, teamSlugById.get(p.teamId) ?? ""),
        ),
      } satisfies TeardownPlan,
    };
  });

  // Containers, volumes and uploads — best-effort, detached, from the snapshot.
  if (plan.services.length || plan.databases.length || plan.appSlugs.length)
    teardownTeamResources(plan, "user-delete");

  await recordActivity(
    "member",
    `Deleted the account @${result.username}` +
      (result.teamsDeleted
        ? ` and ${result.teamsDeleted} team${result.teamsDeleted === 1 ? "" : "s"}`
        : ""),
    actor.username,
    null,
  );
  // A silent privilege grant would be the one part of this the log couldn't
  // explain later, so it gets its own line.
  if (healedTeams.length > 0)
    await recordActivity(
      "member",
      `Passed member/team management to the longest-standing member of ` +
        `${healedTeams.join(", ")} — @${result.username} was the last one who could`,
      actor.username,
      null,
    );
  return result;
}

/**
 * Keep every surviving team manageable. Deleting an account cascades its
 * memberships, which is the one way a team can lose its last `manage_members` /
 * `manage_team` holder without passing through `removeMember`'s coverage check —
 * and a team with nobody able to manage members can never be repaired from
 * inside the product. The longest-standing remaining member inherits the
 * capability (their role is untouched). Disclosed before the fact by
 * `vacatedTeams` on {@link getDeleteUserImpact}. Returns the team ids healed, so
 * the caller can record the grant in the activity log.
 */
async function healCriticalCapabilities(
  tx: DbTx,
  teamIds: string[],
): Promise<string[]> {
  const healed: string[] = [];
  for (const teamId of teamIds) {
    const missing: Capability[] = [];
    for (const cap of CRITICAL_CAPABILITIES) {
      const holders = await capabilityHolders(tx, teamId, cap);
      if (holders.length === 0) missing.push(cap);
    }
    if (missing.length === 0) continue;
    const heir = (
      await tx
        .select({ id: membershipsTable.id })
        .from(membershipsTable)
        .where(eq(membershipsTable.teamId, teamId))
        .orderBy(membershipsTable.createdAt)
        .limit(1)
    )[0];
    // No members left at all ⇒ the team was deleted with the account (or has
    // been emptied by something else): nothing to keep manageable.
    if (!heir) continue;
    await tx
      .insert(membershipCapabilitiesTable)
      .values(missing.map((c) => ({ membershipId: heir.id, capability: c })))
      .onConflictDoNothing();
    healed.push(teamId);
  }
  return healed;
}
