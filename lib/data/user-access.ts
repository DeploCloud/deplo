import "server-only";

import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  activities as activitiesTable,
  appGrants as appGrantsTable,
  apps as appsTable,
  folderGrants as folderGrantsTable,
  folders as foldersTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projectGrants as projectGrantsTable,
  projects as projectsTable,
  teamRoles as teamRolesTable,
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { getCurrentUser } from "../auth";
import { assembleActivity } from "./infra-rows";
import { newId, nowIso } from "../ids";
import { requireInstanceAdmin, teamsForUser } from "../membership";
import { NODE_GRANTABLE_CAPABILITIES, boundedBy } from "../membership-shared";
import { recordActivity } from "./activity";
import { assertAdminCoverage, teamFounderUserId } from "./members";
import { instanceOwnerUserId } from "./instance-owner";
import { ensureTeamRoles, roleAssignment } from "./roles";
import { buildScopeTree, type ScopeTreeTeam } from "./tokens";
import { withView } from "./node-access";
import type { Activity, Capability } from "../types";

/**
 * Instance-admin administration of ONE person's access across the whole
 * instance — the server half of Settings → Users → a user.
 *
 * Everything here is `requireInstanceAdmin()`, never `requireCapability`: an
 * admin answering "who can touch Prod?" is by definition editing teams they may
 * not belong to, and until now the only answer was "ask whoever runs that team".
 * That is exactly the shape the mission rules out.
 *
 * It does NOT relax any team-internal rule. The three guards that make team
 * membership safe are reused verbatim from `lib/data/members.ts` — the founder's
 * crown is immutable, the instance owner's row is closed to everyone but
 * themselves, and `assertAdminCoverage` keeps a team from losing its last member
 * who can administer it. `updateMember` itself is untouched.
 *
 * Two modes per team (ADR-0016):
 *  - **role** — the membership points at a `team_roles` row, as it always has;
 *  - **granular** — the same role supplies the BASE, plus per-node capability
 *    sets that replace it inside the projects, folders and apps they name.
 * The role is never dropped in granular mode, so editing a Role still reaches
 * everyone who holds it.
 */

/** One node an access set is attached to. */
export interface AccessNodeGrant {
  kind: "project" | "folder" | "app";
  nodeId: string;
  name: string;
  capabilities: Capability[];
}

/** A person's access in one team, as the admin page shows and saves it. */
export interface UserTeamAccessDTO {
  teamId: string;
  teamName: string;
  /** The assigned role, or null for a hand-picked ("Custom") capability set. */
  roleId: string | null;
  roleName: string | null;
  /** The membership RANK — `owner` outranks everyone. */
  rank: string;
  /** Whether per-node overrides are in play (the admin's mode choice). */
  granular: boolean;
  /** What applies outside every granted node. */
  baseCapabilities: Capability[];
  nodes: AccessNodeGrant[];
  /** The team's founder can't be edited by anyone, admins included. */
  isFounder: boolean;
}

/** What the page needs to render one team's mode switch. */
export interface TeamRoleOption {
  id: string;
  name: string;
  rank: string;
}

/** One node grant as the client sends it back. */
export interface NodeGrantInput {
  projectIds?: string[];
  folderIds?: string[];
  appIds?: string[];
  capabilities: Capability[];
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Every team `userId` belongs to, with their access in it. Instance admin only. */
export async function listUserAccess(
  userId: string,
): Promise<UserTeamAccessDTO[]> {
  await requireInstanceAdmin();
  const db = getDb();

  const rows = await db
    .select({
      membershipId: membershipsTable.id,
      teamId: membershipsTable.teamId,
      teamName: teamsTable.name,
      founderUserId: teamsTable.founderUserId,
      rank: membershipsTable.role,
      roleId: membershipsTable.roleId,
      roleName: teamRolesTable.name,
      granular: membershipsTable.granular,
    })
    .from(membershipsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .leftJoin(teamRolesTable, eq(teamRolesTable.id, membershipsTable.roleId))
    .where(eq(membershipsTable.userId, userId))
    .orderBy(asc(teamsTable.createdAt));
  if (rows.length === 0) return [];

  const capRows = await db
    .select({
      membershipId: membershipCapabilitiesTable.membershipId,
      capability: membershipCapabilitiesTable.capability,
    })
    .from(membershipCapabilitiesTable)
    .where(
      inArray(
        membershipCapabilitiesTable.membershipId,
        rows.map((r) => r.membershipId),
      ),
    );
  const capsByMembership = new Map<string, Capability[]>();
  for (const c of capRows) {
    const list = capsByMembership.get(c.membershipId) ?? [];
    list.push(c.capability as Capability);
    capsByMembership.set(c.membershipId, list);
  }

  const nodes = await nodeGrantsFor(userId);

  return rows.map((r) => ({
    teamId: r.teamId,
    teamName: r.teamName,
    roleId: r.roleId ?? null,
    roleName: r.roleName ?? null,
    rank: r.rank,
    granular: r.granular,
    baseCapabilities: withView(capsByMembership.get(r.membershipId) ?? []),
    nodes: nodes.get(r.teamId) ?? [],
    isFounder: r.founderUserId === userId,
  }));
}

/** Every node grant this user holds, grouped by owning team, with node names. */
async function nodeGrantsFor(
  userId: string,
): Promise<Map<string, AccessNodeGrant[]>> {
  const db = getDb();
  const [projectRows, folderRows, appRows] = await Promise.all([
    db
      .select({
        nodeId: projectGrantsTable.projectId,
        capability: projectGrantsTable.capability,
        teamId: projectsTable.teamId,
        name: projectsTable.name,
      })
      .from(projectGrantsTable)
      .innerJoin(projectsTable, eq(projectsTable.id, projectGrantsTable.projectId))
      .where(eq(projectGrantsTable.userId, userId)),
    db
      .select({
        nodeId: folderGrantsTable.folderId,
        capability: folderGrantsTable.capability,
        teamId: foldersTable.teamId,
        name: foldersTable.name,
      })
      .from(folderGrantsTable)
      .innerJoin(foldersTable, eq(foldersTable.id, folderGrantsTable.folderId))
      .where(eq(folderGrantsTable.userId, userId)),
    db
      .select({
        nodeId: appGrantsTable.appId,
        capability: appGrantsTable.capability,
        teamId: appsTable.teamId,
        name: appsTable.name,
      })
      .from(appGrantsTable)
      .innerJoin(appsTable, eq(appsTable.id, appGrantsTable.appId))
      .where(eq(appGrantsTable.userId, userId)),
  ]);

  const byTeam = new Map<string, Map<string, AccessNodeGrant>>();
  const add = (
    kind: AccessNodeGrant["kind"],
    r: { nodeId: string; capability: string; teamId: string; name: string },
  ) => {
    const team = byTeam.get(r.teamId) ?? new Map<string, AccessNodeGrant>();
    const key = `${kind}:${r.nodeId}`;
    const node =
      team.get(key) ?? { kind, nodeId: r.nodeId, name: r.name, capabilities: [] };
    node.capabilities = [...node.capabilities, r.capability as Capability];
    team.set(key, node);
    byTeam.set(r.teamId, team);
  };
  for (const r of projectRows) add("project", r);
  for (const r of folderRows) add("folder", r);
  for (const r of appRows) add("app", r);

  const out = new Map<string, AccessNodeGrant[]>();
  for (const [teamId, nodes] of byTeam) {
    out.set(
      teamId,
      [...nodes.values()].map((n) => ({
        ...n,
        capabilities: withView(n.capabilities),
      })),
    );
  }
  return out;
}

/**
 * The scope tree rooted at the TARGET's teams — the same picker the token editor
 * draws, built from someone else's memberships. Instance admin only.
 */
export async function listUserAccessTree(
  userId: string,
): Promise<ScopeTreeTeam[]> {
  await requireInstanceAdmin();
  return buildScopeTree(await teamsForUser(userId));
}

/**
 * The roles assignable in each of `teamIds`, keyed by team — one query for the
 * whole page rather than one per team row. Instance admin only.
 *
 * `ensureTeamRoles` is lazy, so a team that has never opened its Roles page has
 * no rows yet; seeding here is what stops the picker being empty for it.
 */
export async function listRoleOptions(
  teamIds: string[],
): Promise<Record<string, TeamRoleOption[]>> {
  await requireInstanceAdmin();
  const db = getDb();
  if (teamIds.length === 0) return {};
  for (const teamId of teamIds) await ensureTeamRoles(db, teamId);
  const rows = await db
    .select({
      id: teamRolesTable.id,
      teamId: teamRolesTable.teamId,
      name: teamRolesTable.name,
      builtinKey: teamRolesTable.builtinKey,
    })
    .from(teamRolesTable)
    .where(inArray(teamRolesTable.teamId, teamIds))
    .orderBy(asc(teamRolesTable.createdAt));
  const out: Record<string, TeamRoleOption[]> = {};
  for (const teamId of teamIds) out[teamId] = [];
  for (const r of rows) {
    out[r.teamId]?.push({
      id: r.id,
      name: r.name,
      rank: r.builtinKey ?? "member",
    });
  }
  return out;
}

/** Teams this person is NOT in yet — what "Add to a team" offers. Admin only. */
export async function listJoinableTeams(
  userId: string,
): Promise<{ id: string; name: string }[]> {
  await requireInstanceAdmin();
  const mine = new Set((await teamsForUser(userId)).map((t) => t.id));
  const rows = await getDb()
    .select({ id: teamsTable.id, name: teamsTable.name })
    .from(teamsTable)
    .orderBy(asc(teamsTable.createdAt));
  return rows.filter((t) => !mine.has(t.id));
}

/**
 * What this person has DONE, newest first, across every team — the Activity card
 * on their page. Instance admin only; served by `activities_actor_created_idx`.
 */
export async function listUserActivity(
  userId: string,
  limit = 10,
): Promise<(Activity & { teamName: string })[]> {
  await requireInstanceAdmin();
  const rows = await getDb()
    .select({ activity: activitiesTable, teamName: teamsTable.name })
    .from(activitiesTable)
    .innerJoin(teamsTable, eq(teamsTable.id, activitiesTable.teamId))
    .where(eq(activitiesTable.actorUserId, userId))
    .orderBy(desc(activitiesTable.createdAt), desc(activitiesTable.seq))
    .limit(limit);
  return rows.map((r) => ({
    ...assembleActivity(r.activity),
    teamName: r.teamName,
  }));
}

/* ------------------------------------------------------------------ */
/* Writes                                                              */
/* ------------------------------------------------------------------ */

/**
 * Set one person's access in one team: their base role, whether per-node
 * overrides apply, and the overrides themselves. Instance admin only.
 *
 * Whole-set replace in one transaction — the node rows the caller doesn't send
 * are gone when it returns, so the page never has to reason about a partial save.
 */
export async function setUserTeamAccess(input: {
  userId: string;
  teamId: string;
  roleId: string;
  granular: boolean;
  grants?: NodeGrantInput[];
}): Promise<UserTeamAccessDTO[]> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  const db = getDb();
  await ensureTeamRoles(db, input.teamId);
  const assignment = await roleAssignment(db, input.teamId, input.roleId);
  const resolved = input.granular
    ? await resolveGrants(input.teamId, input.grants ?? [])
    : [];

  await db.transaction(async (tx) => {
    const m = await requireEditableMembership(
      tx,
      input.userId,
      input.teamId,
      actingUserId,
    );
    await assertAdminCoverage(tx, input.teamId, input.userId, assignment.capabilities);
    await tx
      .update(membershipsTable)
      .set({
        role: assignment.rank,
        roleId: assignment.roleId,
        granular: input.granular,
      })
      .where(eq(membershipsTable.id, m.id));
    await tx
      .delete(membershipCapabilitiesTable)
      .where(eq(membershipCapabilitiesTable.membershipId, m.id));
    await tx.insert(membershipCapabilitiesTable).values(
      assignment.capabilities.map((c) => ({
        membershipId: m.id,
        capability: c,
      })),
    );
    await clearNodeGrants(tx, input.userId, input.teamId);
    await writeNodeGrants(tx, input.userId, resolved);
  });

  await recordUserAccess(
    input.userId,
    input.teamId,
    input.granular
      ? `granular access (${resolved.length} nodes) with the ${assignment.name} role`
      : `the ${assignment.name} role`,
  );
  return listUserAccess(input.userId);
}

/** Add this person to a team with a role. Instance admin only. */
export async function addUserToTeam(input: {
  userId: string;
  teamId: string;
  roleId: string;
}): Promise<UserTeamAccessDTO[]> {
  await requireInstanceAdmin();
  const db = getDb();
  await ensureTeamRoles(db, input.teamId);
  const assignment = await roleAssignment(db, input.teamId, input.roleId);

  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: membershipsTable.id })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.userId, input.userId),
          eq(membershipsTable.teamId, input.teamId),
        ),
      )
      .limit(1);
    if (existing[0]) throw new Error("They are already in this team");
    const membershipId = newId("mem");
    await tx.insert(membershipsTable).values({
      id: membershipId,
      userId: input.userId,
      teamId: input.teamId,
      role: assignment.rank,
      roleId: assignment.roleId,
      granular: false,
      createdAt: nowIso(),
    });
    await tx.insert(membershipCapabilitiesTable).values(
      assignment.capabilities.map((c) => ({
        membershipId,
        capability: c,
      })),
    );
  });

  await recordUserAccess(
    input.userId,
    input.teamId,
    `the ${assignment.name} role`,
    "Added",
  );
  return listUserAccess(input.userId);
}

/**
 * Take this person out of a team entirely — the answer to "revoke their access",
 * and since ADR-0016 the ONE thing that revokes every node grant at once.
 * Instance admin only.
 */
export async function removeUserFromTeam(input: {
  userId: string;
  teamId: string;
}): Promise<UserTeamAccessDTO[]> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  await getDb().transaction(async (tx) => {
    const m = await requireEditableMembership(
      tx,
      input.userId,
      input.teamId,
      actingUserId,
    );
    await assertAdminCoverage(tx, input.teamId, input.userId, null);
    // The node grants are NOT cascaded by the membership FK (they hang off the
    // app/folder/project), so removal has to clear them itself — otherwise
    // re-adding the person later would silently restore their old corners.
    await clearNodeGrants(tx, input.userId, input.teamId);
    await tx.delete(membershipsTable).where(eq(membershipsTable.id, m.id));
  });
  await recordUserAccess(input.userId, input.teamId, "no access", "Removed");
  return listUserAccess(input.userId);
}

/* ------------------------------------------------------------------ */
/* Guards and helpers                                                  */
/* ------------------------------------------------------------------ */

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/**
 * The membership row, if this admin may touch it. Two accounts are closed:
 * the team's FOUNDER (the crown is immutable to everyone, instance admins
 * included — same rule `updateMember` enforces) and the INSTANCE OWNER, whose
 * row only they may change (`lib/data/instance-owner.ts`).
 */
async function requireEditableMembership(
  tx: Tx,
  userId: string,
  teamId: string,
  actingUserId: string,
): Promise<{ id: string }> {
  if (userId === (await teamFounderUserId(tx, teamId))) {
    throw new Error("The team's primary owner's access can't be changed.");
  }
  // Read through the TX, not a fresh connection: an outer query issued while a
  // transaction is open waits on it, and under pglite (one connection, the test
  // harness) that is a hang, not a slow query.
  const owner = await instanceOwnerUserId(tx);
  if (owner && userId === owner && actingUserId !== owner) {
    throw new Error(
      "That account owns the instance — only its owner can change it.",
    );
  }
  const rows = await tx
    .select({ id: membershipsTable.id })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.userId, userId),
        eq(membershipsTable.teamId, teamId),
      ),
    )
    .limit(1);
  if (!rows[0]) throw new Error("They are not in this team");
  return rows[0];
}

/** A node grant validated against the team it claims to be in. */
interface ResolvedGrant {
  kind: "project" | "folder" | "app";
  nodeId: string;
  capabilities: Capability[];
}

/**
 * Check every ticked node really belongs to `teamId` and bound each set to
 * {@link NODE_GRANTABLE_CAPABILITIES}. Refuses loudly rather than silently
 * dropping, so an admin is told why `manage_members` isn't on offer per node.
 */
async function resolveGrants(
  teamId: string,
  grants: NodeGrantInput[],
): Promise<ResolvedGrant[]> {
  const db = getDb();
  const out: ResolvedGrant[] = [];
  for (const g of grants) {
    const caps = withView(g.capabilities);
    const beyond = caps.filter((c) => !NODE_GRANTABLE_CAPABILITIES.includes(c));
    if (beyond.length > 0) {
      throw new Error(
        `${beyond[0]} applies to the whole team, so it can't be given on a single project, folder or app`,
      );
    }
    const bounded = boundedBy(caps, NODE_GRANTABLE_CAPABILITIES);
    for (const [kind, ids] of [
      ["project", g.projectIds ?? []],
      ["folder", g.folderIds ?? []],
      ["app", g.appIds ?? []],
    ] as const) {
      if (ids.length === 0) continue;
      const table =
        kind === "project" ? projectsTable : kind === "folder" ? foldersTable : appsTable;
      const found = await db
        .select({ id: table.id })
        .from(table)
        .where(and(inArray(table.id, ids), eq(table.teamId, teamId)));
      if (found.length !== new Set(ids).size) {
        throw new Error("One of those isn't in this team any more");
      }
      for (const id of new Set(ids))
        out.push({ kind, nodeId: id, capabilities: bounded });
    }
  }
  return out;
}

/** Drop every node grant this user holds inside one team. */
async function clearNodeGrants(
  tx: Tx,
  userId: string,
  teamId: string,
): Promise<void> {
  const projectIds = tx
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(eq(projectsTable.teamId, teamId));
  const folderIds = tx
    .select({ id: foldersTable.id })
    .from(foldersTable)
    .where(eq(foldersTable.teamId, teamId));
  const appIds = tx
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(eq(appsTable.teamId, teamId));
  await tx
    .delete(projectGrantsTable)
    .where(
      and(
        eq(projectGrantsTable.userId, userId),
        inArray(projectGrantsTable.projectId, projectIds),
      ),
    );
  await tx
    .delete(folderGrantsTable)
    .where(
      and(
        eq(folderGrantsTable.userId, userId),
        inArray(folderGrantsTable.folderId, folderIds),
      ),
    );
  await tx
    .delete(appGrantsTable)
    .where(
      and(eq(appGrantsTable.userId, userId), inArray(appGrantsTable.appId, appIds)),
    );
}

/**
 * Write the resolved node grants. `view` is never stored: it is implied for
 * anyone who can reach a node at all, and a row holding only `view` would be
 * indistinguishable from no grant — which is what makes "has rows" mean "says
 * something" in `lib/data/node-access.ts`.
 */
async function writeNodeGrants(
  tx: Tx,
  userId: string,
  grants: ResolvedGrant[],
): Promise<void> {
  for (const g of grants) {
    const caps = g.capabilities.filter((c) => c !== "view");
    if (caps.length === 0) continue;
    if (g.kind === "project") {
      await tx
        .insert(projectGrantsTable)
        .values(caps.map((c) => ({ projectId: g.nodeId, userId, capability: c })))
        .onConflictDoNothing();
    } else if (g.kind === "folder") {
      await tx
        .insert(folderGrantsTable)
        .values(caps.map((c) => ({ folderId: g.nodeId, userId, capability: c })))
        .onConflictDoNothing();
    } else {
      await tx
        .insert(appGrantsTable)
        .values(caps.map((c) => ({ appId: g.nodeId, userId, capability: c })))
        .onConflictDoNothing();
    }
  }
}

/**
 * Log the change in the AFFECTED team's Activity, so "who can do what, and who
 * changed it" is answerable from the UI — including by people who can't see
 * Settings → Users. Runs OUTSIDE the transaction (own connection).
 */
async function recordUserAccess(
  userId: string,
  teamId: string,
  what: string,
  verb = "Set",
): Promise<void> {
  const rows = await getDb()
    .select({ username: usersTable.username })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  const who = rows[0]?.username ?? "a user";
  // The ACTING admin is the actor, so the trail names a person rather than a
  // role — `recordActivity` attributes it to their account when the name matches.
  const actor = (await getCurrentUser())?.name ?? "Someone";
  await recordActivity(
    "member",
    `${verb} @${who}'s access to ${what}`,
    actor,
    null,
    teamId,
  );
}
