import "server-only";

import { and, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, type DbTx } from "../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../db/schema/control-plane/access-control";
import { apiTokens as apiTokensTable } from "../db/schema/control-plane/api-tokens";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { appPreviews as appPreviewsTable } from "../db/schema/control-plane/deployments";
import {
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane/identity";
import { installedPlugins as installedPluginsTable } from "../db/schema/control-plane/integrations";
import {
  folders as foldersTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";
import { getCurrentUser } from "../auth/current-user";
import { requireInstanceAdmin } from "../membership";
import { recordActivity } from "./activity";
import { instanceOwnerUserId } from "./instance-owner";
import { pluginSlug } from "../plugins/runtime";
import { teardownTeamResources, type TeardownPlan } from "./team-delete";
import { handOverFolders } from "./node-grants";
import type { Capability } from "../types/identity";

export interface DeleteUserTeamImpact {
  teamId: string;
  name: string;
  appCount: number;
  databaseCount: number;
  otherMemberCount: number;
}

export interface DeleteUserImpact {
  userId: string;
  username: string;
  name: string;
  blockedReason: string | null;
  soloTeams: DeleteUserTeamImpact[];
  foundedTeams: DeleteUserTeamImpact[];
  keptTeams: { teamId: string; name: string }[];
  createdAppCount: number;
  ownedFolderCount: number;
  ownedProjectCount: number;
  ownedAppCount: number;
  tokenCount: number;
  vacatedTeams: string[];
}

export interface DeleteUserOptions {
  deleteCreatedApps: boolean;
  deleteOwnedWorkspaces: boolean;
  deleteFoundedTeams: boolean;
}

export interface DeleteUserResult {
  username: string;
  teamsDeleted: number;
  appsDeleted: number;
  databasesDeleted: number;
}

const CRITICAL_CAPABILITIES: Capability[] = [
  "manage_members",
  "manage_roles",
  "manage_team",
];

interface TeamShape {
  teamId: string;
  name: string;
  slug: string;
  memberCount: number;
  isMember: boolean;
  isFounder: boolean;
}

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

function isSoloTeam(t: TeamShape): boolean {
  return t.isMember && t.memberCount <= 1;
}

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

async function blockedReasonFor(
  userId: string,
  actingUserId: string,
  tx?: DbTx,
): Promise<string | null> {
  if (userId === actingUserId)
    return "You can't delete your own account. Ask another instance admin to do it.";
  const owner = await instanceOwnerUserId(tx);
  if (owner !== null && owner === userId)
    return "The instance owner's account can't be deleted. Transfer ownership first.";
  return null;
}

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
    createdAppCount: (await createdAppRows(db, userId, survivingTeamIds))
      .length,
    ownedFolderCount: ownedFolders.length,
    ownedProjectCount: ownedProjects.length,
    ownedAppCount: (
      await appsInWorkspaces(db, ownedFolders, ownedProjects, survivingTeamIds)
    ).length,
    tokenCount: Number(tokens[0]?.n ?? 0),
    vacatedTeams: await vacatedTeamNames(db, userId, survivingTeamIds),
  };
}

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
    projectIds.length > 0
      ? inArray(appsTable.projectId, projectIds)
      : undefined,
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

export async function deleteUser(
  userId: string,
  options: DeleteUserOptions,
): Promise<DeleteUserResult> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  const actor = (await getCurrentUser())!;

  const { result, plan, healedTeams, handed } = await getDb().transaction(
    async (tx) => {
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

      const teams = await teamsAroundUser(tx, userId);
      const teamsToDelete = teams.filter(
        (t) => isSoloTeam(t) || (options.deleteFoundedTeams && t.isFounder),
      );
      const deletedTeamIds = teamsToDelete.map((t) => t.teamId);
      const survivingTeamIds = teams
        .filter((t) => !deletedTeamIds.includes(t.teamId))
        .map((t) => t.teamId);

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
      const teamSlugById = new Map(
        teamsToDelete.map((t) => [t.teamId, t.slug]),
      );

      const ownedFolders = options.deleteOwnedWorkspaces
        ? await ownedFolderIds(tx, userId, survivingTeamIds)
        : [];
      const ownedProjects = options.deleteOwnedWorkspaces
        ? await ownedProjectIds(tx, userId, survivingTeamIds)
        : [];
      const looseApps = new Map<
        string,
        { id: string; slug: string; serverId: string }
      >();
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

      const doomedAppIds = [...teamApps.map((a) => a.id), ...looseApps.keys()];
      const previewStacks = doomedAppIds.length
        ? (
            await tx
              .select({
                id: appPreviewsTable.id,
                deployKey: appPreviewsTable.deployKey,
                serverId: sql<string>`coalesce(${appsTable.previewServerId}, ${appsTable.serverId})`,
              })
              .from(appPreviewsTable)
              .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId))
              .where(
                and(
                  inArray(appPreviewsTable.appId, doomedAppIds),
                  isNull(appPreviewsTable.tornDownAt),
                ),
              )
          ).map((r) => ({
            id: r.id,
            deployKey: r.deployKey,
            serverId: r.serverId,
          }))
        : [];

      if (looseApps.size > 0)
        await tx
          .delete(appsTable)
          .where(inArray(appsTable.id, [...looseApps.keys()]));
      if (ownedFolders.length > 0)
        await tx
          .delete(foldersTable)
          .where(inArray(foldersTable.id, ownedFolders));
      if (ownedProjects.length > 0)
        await tx
          .delete(projectsTable)
          .where(inArray(projectsTable.id, ownedProjects));
      const handed: string[] = [];
      for (const t of teams) {
        if (deletedTeamIds.includes(t.teamId)) continue;
        const heir = t.isFounder
          ? actingUserId
          : ((await teamFounderOf(tx, t.teamId)) ?? actingUserId);
        const n = await handOverFolders(tx, userId, t.teamId, heir);
        if (n > 0) handed.push(`${n} in ${t.name}`);
      }
      if (deletedTeamIds.length > 0)
        await tx
          .delete(teamsTable)
          .where(inArray(teamsTable.id, deletedTeamIds));
      await tx.delete(usersTable).where(eq(usersTable.id, userId));

      const healed = await healCriticalCapabilities(tx, survivingTeamIds);

      return {
        handed,
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
          previewStacks,
          databases: teamDatabases,
          appSlugs: teamPlugins.map(
            (p) =>
              p.slug ||
              pluginSlug(p.catalogId, teamSlugById.get(p.teamId) ?? ""),
          ),
        } satisfies TeardownPlan,
      };
    },
  );

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
  if (handed.length > 0)
    await recordActivity(
      "member",
      `Folders @${result.username} owned now belong to the primary owner: ${handed.join(", ")}`,
      actor.username,
      null,
    );
  if (healedTeams.length > 0)
    await recordActivity(
      "member",
      `Passed member/team management to the longest-standing member of ` +
        `${healedTeams.join(", ")} - @${result.username} was the last one who could`,
      actor.username,
      null,
    );
  return result;
}

async function teamFounderOf(tx: DbTx, teamId: string): Promise<string | null> {
  const rows = await tx
    .select({ founderUserId: teamsTable.founderUserId })
    .from(teamsTable)
    .where(eq(teamsTable.id, teamId))
    .limit(1);
  return rows[0]?.founderUserId ?? null;
}

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
    if (!heir) continue;
    await tx
      .insert(membershipCapabilitiesTable)
      .values(missing.map((c) => ({ membershipId: heir.id, capability: c })))
      .onConflictDoNothing();
    await tx
      .update(membershipsTable)
      .set({ roleId: null })
      .where(eq(membershipsTable.id, heir.id));
    healed.push(teamId);
  }
  return healed;
}
