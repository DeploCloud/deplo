import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  appGrants as appGrantsTable,
  folderGrants as folderGrantsTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  projectGrants as projectGrantsTable,
  teamRoles as teamRolesTable,
} from "../db/schema/control-plane/access-control";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import {
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane/identity";
import {
  folders as foldersTable,
  projects as projectsTable,
} from "../db/schema/control-plane/projects";
import { getCurrentUser } from "../auth/current-user";
import { newId, nowIso } from "../ids";
import { requireCapability, requireInstanceAdmin } from "../membership";
import {
  CAPABILITY_META,
  NODE_GRANTABLE_CAPABILITIES,
  boundedBy,
  cleanCapabilities,
  sameCapabilities,
} from "../membership-shared";
import { recordActivity } from "./activity";
import { assertAdminCoverage } from "./members/assignment";
import { teamFounderUserId } from "./members/roster";
import { instanceOwnerUserId } from "./instance-owner";
import { ensureTeamRoles } from "./roles/builtin-roles";
import { roleAssignment } from "./roles/role-assignment";
import { nodeCapabilitiesFor, withView } from "./node-access";
import {
  clearNodeGrants,
  handOverFolders,
  recordFoldersHanded,
} from "./node-grants";
import type { Capability, Membership } from "../types/identity";
import type { AlertKey } from "../types/notification";

export interface AccessNodeGrant {
  kind: "project" | "folder" | "app";
  nodeId: string;
  name: string;
  capabilities: Capability[];
}

export interface UserTeamAccessDTO {
  teamId: string;
  teamName: string;
  roleId: string | null;
  roleName: string | null;
  rank: string;
  granular: boolean;
  baseCapabilities: Capability[];
  customCapabilities: boolean;
  nodes: AccessNodeGrant[];
  isFounder: boolean;
}

export interface NodeGrantInput {
  projectIds?: string[];
  folderIds?: string[];
  appIds?: string[];
  capabilities: Capability[];
}

export async function listUserAccess(
  userId: string,
): Promise<UserTeamAccessDTO[]> {
  await requireInstanceAdmin();
  return loadUserAccess(userId);
}

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

export async function getMemberAccess(
  userId: string,
): Promise<UserTeamAccessDTO | null> {
  const { teamId } = await requireCapability("manage_members");
  return (await loadUserAccess(userId, teamId))[0] ?? null;
}

export async function setUserTeamAccess(input: {
  userId: string;
  teamId: string;
  roleId: string;
  granular: boolean;
  grants?: NodeGrantInput[];
}): Promise<UserTeamAccessDTO[]> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  await writeAccess(actingUserId, input, null);
  return listUserAccess(input.userId);
}

export async function setMemberAccess(input: {
  userId: string;
  roleId: string;
  granular: boolean;
  grants?: NodeGrantInput[];
  capabilities?: Capability[];
}): Promise<UserTeamAccessDTO[]> {
  const {
    teamId,
    userId: actingUserId,
    membership,
  } = await requireCapability("manage_members");
  await writeAccess(actingUserId, { ...input, teamId }, membership);
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
  actor: Membership | null,
): Promise<void> {
  const db = getDb();
  await ensureTeamRoles(db, input.teamId);
  const assignment = await roleAssignment(db, input.teamId, input.roleId);
  const effective = memberCapabilities(assignment, input);
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
  const resolved = await resolveGrants(
    input.teamId,
    actingUserId,
    input.grants ?? [],
  );

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
    if (input.granular || input.grants !== undefined || m.granular) {
      await clearNodeGrants(tx, input.userId, input.teamId);
      await writeNodeGrants(tx, input.userId, resolved);
    }
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

function memberCapabilities(
  assignment: { capabilities: Capability[]; scoped: boolean },
  input: { granular: boolean; capabilities?: Capability[] },
): Capability[] {
  const own = input.capabilities
    ? withView(cleanCapabilities(input.capabilities, "viewer"))
    : assignment.capabilities;
  return input.granular || assignment.scoped
    ? boundedBy(own, NODE_GRANTABLE_CAPABILITIES)
    : own;
}

export async function addUserToTeam(input: {
  userId: string;
  teamId: string;
  roleId: string;
}): Promise<UserTeamAccessDTO[]> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  if (input.userId === actingUserId)
    throw new Error("You can't add yourself to a team. Ask another admin.");
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

export async function removeUserFromTeam(input: {
  userId: string;
  teamId: string;
}): Promise<UserTeamAccessDTO[]> {
  const { userId: actingUserId } = await requireInstanceAdmin();
  let handed = 0;
  await getDb().transaction(async (tx) => {
    const m = await requireEditableMembership(
      tx,
      input.userId,
      input.teamId,
      actingUserId,
    );
    await assertAdminCoverage(tx, input.teamId, input.userId, null);
    await clearNodeGrants(tx, input.userId, input.teamId);
    handed = await handOverFolders(
      tx,
      input.userId,
      input.teamId,
      (await teamFounderUserId(tx, input.teamId)) ?? actingUserId,
    );
    await tx.delete(membershipsTable).where(eq(membershipsTable.id, m.id));
  });
  await recordUserAccess(input.userId, input.teamId, "no access", "Removed");
  await recordFoldersHanded(input.userId, input.teamId, handed);
  return listUserAccess(input.userId);
}

type Tx = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

async function requireEditableMembership(
  tx: Tx,
  userId: string,
  teamId: string,
  actingUserId: string,
): Promise<{ id: string; granular: boolean }> {
  if (userId === actingUserId) {
    throw new Error("You can't change your own access. Ask another admin.");
  }
  if (userId === (await teamFounderUserId(tx, teamId))) {
    throw new Error("The team's primary owner's access can't be changed.");
  }
  const owner = await instanceOwnerUserId(tx);
  if (owner && userId === owner && actingUserId !== owner) {
    throw new Error(
      "That account owns the instance - only its owner can change it.",
    );
  }
  const rows = await tx
    .select({ id: membershipsTable.id, granular: membershipsTable.granular })
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

interface ResolvedGrant {
  kind: "project" | "folder" | "app";
  nodeId: string;
  capabilities: Capability[];
}

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
        const mine = await nodeCapabilitiesFor(actingUserId, teamId, {
          kind,
          id,
        });
        if (mine.length === 0)
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

const ACCESS_ALERT: Record<string, AlertKey> = {
  Added: "member_joined",
  Removed: "member_removed",
  Set: "member_access_changed",
};
