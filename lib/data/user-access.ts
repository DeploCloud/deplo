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
import {
  isInstanceAdmin,
  requireCapability,
  requireInstanceAdmin,
  teamsForUser,
} from "../membership";
import {
  CAPABILITY_META,
  NODE_GRANTABLE_CAPABILITIES,
  boundedBy,
  cleanCapabilities,
  sameCapabilities,
} from "../membership-shared";
import { recordActivity } from "./activity";
import { assertAdminCoverage, teamFounderUserId } from "./members";
import { instanceOwnerUserId } from "./instance-owner";
import { ensureTeamRoles, roleAssignment } from "./roles";
import { buildScopeTree, type ScopeTreeTeam } from "./tokens";
import { nodeCapabilitiesFor, withView } from "./node-access";
import type { Activity, AlertKey, Capability, Membership } from "../types";

/**
 * Instance-admin administration of ONE person's access across the whole instance -
 * the server half of Settings → Users → a user.
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
  /** The membership RANK - `owner` outranks everyone. */
  rank: string;
  /** Their reach is the nodes below, not their role's (the admin's choice). */
  granular: boolean;
  /** The set on the membership: their own when they hold one, else the role's. */
  baseCapabilities: Capability[];
  /** That set is theirs, so editing the role no longer rewrites it. */
  customCapabilities: boolean;
  nodes: AccessNodeGrant[];
  /** The team's founder can't be edited by anyone, admins included. */
  isFounder: boolean;
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
  return loadUserAccess(userId);
}

/**
 * The same read with no gate of its own, for a caller that has already been
 * gated and knows which team it may answer for. `teamId` narrows it to one.
 */
async function loadUserAccess(
  userId: string,
  teamId?: string,
): Promise<UserTeamAccessDTO[]> {
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
      customCapabilities: membershipsTable.customCapabilities,
    })
    .from(membershipsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, membershipsTable.teamId))
    .leftJoin(teamRolesTable, eq(teamRolesTable.id, membershipsTable.roleId))
    .where(
      teamId
        ? and(
            eq(membershipsTable.userId, userId),
            eq(membershipsTable.teamId, teamId),
          )
        : eq(membershipsTable.userId, userId),
    )
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
    customCapabilities: r.customCapabilities,
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
      .innerJoin(
        projectsTable,
        eq(projectsTable.id, projectGrantsTable.projectId),
      )
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
    const node = team.get(key) ?? {
      kind,
      nodeId: r.nodeId,
      name: r.name,
      capabilities: [],
    };
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
 * The scope tree rooted at the TARGET's teams - the same picker the token editor
 * draws, built from someone else's memberships. The flag is therefore derived here
 * rather than passed in, so a second caller cannot arrive with it set.
 */
export async function listUserAccessTree(
  userId: string,
): Promise<ScopeTreeTeam[]> {
  await requireInstanceAdmin();
  // Derived from the answer, not from the gate above: re-gate this function and
  // the filter follows on its own, instead of leaking every private folder in
  // every team the target belongs to.
  const unfiltered = await isInstanceAdmin();
  return buildScopeTree(await teamsForUser(userId), { asCaller: !unfiltered });
}

/**
 * One member's access in the ACTIVE team, for the team-side member page.
 */
export async function getMemberAccess(
  userId: string,
): Promise<UserTeamAccessDTO | null> {
  const { teamId } = await requireCapability("manage_members");
  return (await loadUserAccess(userId, teamId))[0] ?? null;
}

/**
 * What this person has DONE, newest first, across every team - the Activity card
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
 * Set one person's access in one team: their base role, whether per-node overrides
 * apply, and the overrides themselves.
 */
export async function setUserTeamAccess(input: {
  userId: string;
  teamId: string;
  roleId: string;
  granular: boolean;
  grants?: NodeGrantInput[];
}): Promise<UserTeamAccessDTO[]> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  // No actor bound: administering the instance is exactly the power to assign a
  // role you do not hold in a team you may not belong to.
  await writeAccess(actingUserId, input, null);
  return listUserAccess(input.userId);
}

/**
 * The same write, for a team administering its OWN member: `manage_members`, and
 * the team comes from the actor rather than from the input.
 */
export async function setMemberAccess(input: {
  userId: string;
  roleId: string;
  granular: boolean;
  grants?: NodeGrantInput[];
  /**
   * This member's own capability set. Absent (the only thing every older client
   * sends) means "whatever the role gives", which is what it has always meant.
   */
  capabilities?: Capability[];
}): Promise<UserTeamAccessDTO[]> {
  const {
    teamId,
    userId: actingUserId,
    membership,
  } = await requireCapability("manage_members");
  await writeAccess(actingUserId, { ...input, teamId }, membership);
  // Their access in THIS team, which is the only one this door may answer for.
  return loadUserAccess(input.userId, teamId);
}

async function writeAccess(
  actingUserId: string,
  input: {
    userId: string;
    teamId: string;
    roleId: string;
    granular: boolean;
    grants?: NodeGrantInput[];
    capabilities?: Capability[];
  },
  /**
   * The ACTOR's own membership, on the team-side door.
   */
  actor: Membership | null,
): Promise<void> {
  const db = getDb();
  await ensureTeamRoles(db, input.teamId);
  const assignment = await roleAssignment(db, input.teamId, input.roleId);
  const effective = memberCapabilities(assignment, input);
  // Their set is not the role's, so the role must stop rewriting it.
  const customCapabilities = !sameCapabilities(
    effective,
    assignment.capabilities,
  );
  if (actor) {
    const beyond = [...assignment.capabilities, ...effective].filter(
      (c) => !actor.capabilities.includes(c),
    );
    if (beyond.length > 0)
      throw new Error(
        `You can only give someone permissions you hold yourself - you don't have ${CAPABILITY_META[beyond[0]].label.toLowerCase()}`,
      );
    if (assignment.rank === "owner" && actor.role !== "owner")
      throw new Error("Only an owner can make someone an owner");
    // …and an owner's access is an owner's to change. Read before the
    // transaction opens: a query issued while one is open hangs under pglite.
    const target = (
      await db
        .select({ role: membershipsTable.role })
        .from(membershipsTable)
        .where(
          and(
            eq(membershipsTable.userId, input.userId),
            eq(membershipsTable.teamId, input.teamId),
          ),
        )
        .limit(1)
    )[0];
    if (target?.role === "owner" && actor.role !== "owner")
      throw new Error("Only an owner can change another owner's access");
  }
  const resolved = input.granular
    ? await resolveGrants(input.teamId, actingUserId, input.grants ?? [])
    : [];

  await db.transaction(async (tx) => {
    const m = await requireEditableMembership(
      tx,
      input.userId,
      input.teamId,
      actingUserId,
    );
    await assertAdminCoverage(tx, input.teamId, input.userId, effective);
    await tx
      .update(membershipsTable)
      .set({
        role: assignment.rank,
        roleId: assignment.roleId,
        granular: input.granular,
        customCapabilities,
      })
      .where(eq(membershipsTable.id, m.id));
    await tx
      .delete(membershipCapabilitiesTable)
      .where(eq(membershipCapabilitiesTable.membershipId, m.id));
    await tx.insert(membershipCapabilitiesTable).values(
      effective.map((c) => ({
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
      ? `${resolved.length} node${resolved.length === 1 ? "" : "s"} of this team, with the ${assignment.name} role as their base`
      : customCapabilities
        ? `their own set of permissions, with the ${assignment.name} role as their base`
        : `the ${assignment.name} role`,
  );
}

/**
 * The set that lands in `membership_capabilities` - the member's own when the page
 * sent one, the role's otherwise.
 */
function memberCapabilities(
  assignment: { capabilities: Capability[]; scoped: boolean },
  input: { granular: boolean; capabilities?: Capability[] },
): Capability[] {
  if (!input.capabilities) return assignment.capabilities;
  const own = withView(cleanCapabilities(input.capabilities, "viewer"));
  return input.granular || assignment.scoped
    ? boundedBy(own, NODE_GRANTABLE_CAPABILITIES)
    : own;
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
 * Take this person out of a team entirely - the answer to "revoke their access",
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
    // app/folder/project), so removal has to clear them itself, otherwise
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
 * The membership row, if this admin may touch it.
 */
async function requireEditableMembership(
  tx: Tx,
  userId: string,
  teamId: string,
  actingUserId: string,
): Promise<{ id: string }> {
  // Nobody edits their own access here, rank and instance-admin flag included. This
  // function writes reach as well as capabilities, and the one thing a boundary must
  // never be is self-serve: an actor who could widen themselves has no boundary.
  if (userId === actingUserId) {
    throw new Error("You can't change your own access. Ask another admin.");
  }
  if (userId === (await teamFounderUserId(tx, teamId))) {
    throw new Error("The team's primary owner's access can't be changed.");
  }
  // Read through the TX, not a fresh connection: an outer query issued while a
  // transaction is open waits on it, and under pglite (one connection, the test
  // harness) that is a hang, not a slow query.
  const owner = await instanceOwnerUserId(tx);
  if (owner && userId === owner && actingUserId !== owner) {
    throw new Error(
      "That account owns the instance - only its owner can change it.",
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
 * Check every ticked node really belongs to `teamId`, that the ACTOR can reach it
 * and holds there what they are handing out, and bound each set to {@link
 * NODE_GRANTABLE_CAPABILITIES}.
 */
async function resolveGrants(
  teamId: string,
  actingUserId: string,
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
    const wanted = boundedBy(caps, NODE_GRANTABLE_CAPABILITIES);
    for (const [kind, ids] of [
      ["project", g.projectIds ?? []],
      ["folder", g.folderIds ?? []],
      ["app", g.appIds ?? []],
    ] as const) {
      if (ids.length === 0) continue;
      const table =
        kind === "project"
          ? projectsTable
          : kind === "folder"
            ? foldersTable
            : appsTable;
      const found = await db
        .select({ id: table.id })
        .from(table)
        .where(and(inArray(table.id, ids), eq(table.teamId, teamId)));
      if (found.length !== new Set(ids).size) {
        throw new Error("One of those isn't in this team any more");
      }
      for (const id of new Set(ids)) {
        // The team is an ARGUMENT, not the cookie's active team: this door is cross-team by
        // design (an admin answering "who can touch Prod?" is editing teams they may not
        // belong to), and the request-scoped twin answers `[]` for every node outside the
        // team being acted in.
        const mine = await nodeCapabilitiesFor(actingUserId, teamId, {
          kind,
          id,
        });
        if (mine.length === 0)
          // A node they can't reach answers exactly as one that isn't there:
          // the refusal must not confirm which private folders exist.
          throw new Error("One of those isn't in this team any more");
        const bounded = boundedBy(wanted, mine);
        const over = wanted.filter((c) => !bounded.includes(c));
        if (over.length > 0)
          throw new Error(
            `You don't have ${CAPABILITY_META[over[0]].label.toLowerCase()} there yourself, so you can't give it away`,
          );
        out.push({ kind, nodeId: id, capabilities: bounded });
      }
    }
  }
  return out;
}

/** Drop every node grant this user holds inside one team. */
export async function clearNodeGrants(
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
      and(
        eq(appGrantsTable.userId, userId),
        inArray(appGrantsTable.appId, appIds),
      ),
    );
}

/**
 * Write the resolved node grants.
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
        .values(
          caps.map((c) => ({ projectId: g.nodeId, userId, capability: c })),
        )
        .onConflictDoNothing();
    } else if (g.kind === "folder") {
      await tx
        .insert(folderGrantsTable)
        .values(
          caps.map((c) => ({ folderId: g.nodeId, userId, capability: c })),
        )
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
 * changed it" is answerable from the UI, including by people who can't see
 * Settings → Users.
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
  // role - `recordActivity` attributes it to their account when the name matches.
  const actor = (await getCurrentUser())?.name ?? "Someone";
  await recordActivity(
    "member",
    `${verb} @${who}'s access to ${what}`,
    actor,
    null,
    teamId,
    ACCESS_ALERT[verb] ?? "member_access_changed",
  );
}

/** Which alert each verb of {@link recordUserAccess} is. */
const ACCESS_ALERT: Record<string, AlertKey> = {
  Added: "member_joined",
  Removed: "member_removed",
  Set: "member_access_changed",
};
