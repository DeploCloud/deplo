import "server-only";

import { and, count, eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
} from "../../db/schema/control-plane/access-control";
import { newId, nowIso } from "../../ids";
import { recordActivity } from "../activity";
import { requireCapability } from "../../membership";
import { type Capability } from "../../types/identity";
import {
  actorName,
  assertActorCanMandateTwoFactor,
  assertNameFree,
  cleanDescription,
  cleanRoleName,
  roleInTeam,
} from "./role-guards";
import {
  assertTeamAdminCoverage,
  lockTeamMemberships,
  syncMembersOfRole,
  withinActor,
} from "./member-capabilities";
import { ensureTeamRoles } from "./builtin-roles";
import { type TeamRoleDTO } from "./role-list";
import { resolveRoleScope, writeRoleScope, type RoleScopeInput } from "./scope";

// createRole - create a custom role for the active team.
export async function createRole(input: {
  name: string;
  description?: string | null;
  capabilities?: Capability[];
  requireTwoFactor?: boolean;
  // What the role reaches. Absent or null = the whole team.
  scope?: RoleScopeInput | null;
}): Promise<TeamRoleDTO> {
  const { teamId, userId, membership } =
    await requireCapability("manage_roles");
  const name = cleanRoleName(input.name);
  const description = cleanDescription(input.description);
  const capabilities = withinActor(input.capabilities, membership);
  // No self-lockout check on create: a brand-new role has no members yet, so
  // turning the mandate on cannot cut anyone off, the author included.
  const requireTwoFactor = input.requireTwoFactor ?? false;
  const scope = await resolveRoleScope(teamId, userId, input.scope ?? null);
  const db = getDb();
  await ensureTeamRoles(db, teamId);

  const id = newId("role");
  const createdAt = nowIso();
  await db.transaction(async (tx) => {
    await assertNameFree(tx, teamId, name, null);
    await tx.insert(teamRolesTable).values({
      id,
      teamId,
      builtinKey: null,
      name,
      description,
      requireTwoFactor,
      scoped: scope !== null,
      createdAt,
    });
    await tx
      .insert(teamRoleCapabilitiesTable)
      .values(capabilities.map((c) => ({ roleId: id, capability: c })));
    await writeRoleScope(tx, id, scope);
  });
  await recordActivity(
    "member",
    `Created the ${name} role`,
    await actorName(),
    null,
    teamId,
  );
  return {
    id,
    name,
    description,
    builtinKey: null,
    capabilities,
    requireTwoFactor,
    memberCount: 0,
    modified: false,
    locked: false,
    scope,
    createdAt,
  };
}

// updateRole - rename and/or re-scope a role. Every member holding it gets the new
// capability set in the SAME transaction: a role is what its members can do.
export async function updateRole(input: {
  id: string;
  name: string;
  description?: string | null;
  capabilities?: Capability[];
  requireTwoFactor?: boolean;
  // What the role REACHES. Absent leaves it as it is; `null` clears it.
  scope?: RoleScopeInput | null;
}): Promise<void> {
  const { teamId, userId, membership } =
    await requireCapability("manage_roles");
  const name = cleanRoleName(input.name);
  const description = cleanDescription(input.description);
  // ABSENT MEANS "LEAVE IT ALONE" on every optional axis.
  const current = await roleInTeam(getDb(), teamId, input.id);
  const capabilities =
    input.capabilities === undefined
      ? undefined
      : withinActor(input.capabilities, membership);
  const requireTwoFactor = input.requireTwoFactor ?? current.requireTwoFactor;
  if (requireTwoFactor) await assertActorCanMandateTwoFactor(userId, input.id);
  // Resolved BEFORE the transaction: it queries, and a query issued while one is
  // open hangs under pglite. Also refuses an actor handing out reach they don't have.
  const scope =
    input.scope === undefined
      ? undefined
      : await resolveRoleScope(teamId, userId, input.scope);

  await getDb().transaction(async (tx) => {
    const role = await roleInTeam(tx, teamId, input.id);
    if (role.builtinKey === "owner")
      throw new Error(
        "The Owner role always has full access and can't be edited.",
      );
    await assertNameFree(tx, teamId, name, role.id);
    await lockTeamMemberships(tx, teamId);
    const scoped = scope === undefined ? role.scoped : scope !== null;
    await tx
      .update(teamRolesTable)
      .set({ name, description, requireTwoFactor, scoped })
      .where(
        and(eq(teamRolesTable.id, role.id), eq(teamRolesTable.teamId, teamId)),
      );
    if (scope !== undefined) await writeRoleScope(tx, role.id, scope);
    // Re-read under the lock rather than trusting the pre-transaction read: a
    // scope-only edit still has to re-sync, since the clamp keys on `scoped`.
    const authored =
      capabilities ??
      (
        await tx
          .select({ capability: teamRoleCapabilitiesTable.capability })
          .from(teamRoleCapabilitiesTable)
          .where(eq(teamRoleCapabilitiesTable.roleId, role.id))
      ).map((r) => r.capability as Capability);
    // Un-scoping hands holders the whole authored set instead of the clamped one,
    // so it is bounded like every other widening: to what the actor holds.
    if (role.scoped && !scoped) withinActor(authored, membership);
    if (capabilities !== undefined) {
      await tx
        .delete(teamRoleCapabilitiesTable)
        .where(eq(teamRoleCapabilitiesTable.roleId, role.id));
      await tx
        .insert(teamRoleCapabilitiesTable)
        .values(capabilities.map((c) => ({ roleId: role.id, capability: c })));
    }
    await syncMembersOfRole(tx, teamId, role.id, authored, scoped);
    // Runs AFTER the sync: scoping a role clamps its team-wide capabilities away, so
    // losing the last administrator is a question a reach change asks too.
    await assertTeamAdminCoverage(tx, teamId);
  });
  await recordActivity(
    "member",
    `Updated the ${name} role`,
    await actorName(),
    null,
    teamId,
    "member_access_changed",
  );
}

// deleteRole - delete a custom role. Refuses while anyone still holds it: reassigning
// those members is a decision, not something a delete should make silently.
export async function deleteRole(id: string): Promise<void> {
  const { teamId } = await requireCapability("manage_roles");
  let name = "";
  await getDb().transaction(async (tx) => {
    const role = await roleInTeam(tx, teamId, id);
    if (role.builtinKey)
      throw new Error(
        "Default roles can't be deleted. Reset it to its default instead.",
      );
    name = role.name;
    await lockTeamMemberships(tx, teamId);
    const held = await tx
      .select({ n: count() })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.teamId, teamId),
          eq(membershipsTable.roleId, role.id),
        ),
      );
    const n = Number(held[0]?.n ?? 0);
    if (n > 0)
      throw new Error(
        `${n} member${n === 1 ? "" : "s"} still ${n === 1 ? "has" : "have"} the ${role.name} role. Move ${n === 1 ? "them" : "them"} to another role first.`,
      );
    // team_role_capabilities cascades on the role FK.
    await tx
      .delete(teamRolesTable)
      .where(
        and(eq(teamRolesTable.id, role.id), eq(teamRolesTable.teamId, teamId)),
      );
  });
  await recordActivity(
    "member",
    `Deleted the ${name} role`,
    await actorName(),
    null,
    teamId,
    "member_access_changed",
  );
}
