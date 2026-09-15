import "server-only";

import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
} from "../../db/schema/control-plane/access-control";
import { newId, nowIso } from "../../ids";
import { recordActivity } from "../activity";
import { requireCapability } from "../../membership";
import {
  BUILTIN_ROLE_KEYS,
  ROLE_DEFAULTS,
  capabilitiesForRole,
  sameCapabilities,
} from "../../membership-shared";
import { memberScopeFor } from "../node-scope";
import { type Capability, type Role } from "../../types/identity";
import { actorName, assertNameFree, roleInTeam, type Db } from "./role-guards";
import {
  assertTeamAdminCoverage,
  capabilitiesByMembership,
  effectiveRoleCapabilities,
  lockTeamMemberships,
  syncMembersOfRole,
  withinActor,
} from "./member-capabilities";
import { writeRoleScope } from "./scope";

export async function ensureTeamRoles(
  db: Db,
  teamId: string,
): Promise<Map<Role, string>> {
  const present = await db
    .select({ id: teamRolesTable.id, builtinKey: teamRolesTable.builtinKey })
    .from(teamRolesTable)
    .where(
      and(
        eq(teamRolesTable.teamId, teamId),
        isNotNull(teamRolesTable.builtinKey),
      ),
    );
  const byKey = new Map<Role, string>(
    present.map((r) => [r.builtinKey as Role, r.id]),
  );

  for (const key of BUILTIN_ROLE_KEYS) {
    if (byKey.has(key)) continue;
    const id = newId("role");
    // A concurrent first read of the same team races us; the partial unique index on (team_id, builtin_key) decides.
    const inserted = await db
      .insert(teamRolesTable)
      .values({
        id,
        teamId,
        builtinKey: key,
        name: ROLE_DEFAULTS[key].name,
        description: ROLE_DEFAULTS[key].description,
        createdAt: nowIso(),
      })
      .onConflictDoNothing()
      .returning({ id: teamRolesTable.id });
    if (inserted.length === 0) continue;
    await db
      .insert(teamRoleCapabilitiesTable)
      .values(
        capabilitiesForRole(key).map((c) => ({ roleId: id, capability: c })),
      );
    byKey.set(key, id);
  }

  await adoptMatchingMemberships(db, teamId, byKey);
  return byKey;
}

async function adoptMatchingMemberships(
  db: Db,
  teamId: string,
  byKey: Map<Role, string>,
): Promise<void> {
  const rows = await db
    .select({ id: membershipsTable.id, role: membershipsTable.role })
    .from(membershipsTable)
    .where(
      and(eq(membershipsTable.teamId, teamId), isNull(membershipsTable.roleId)),
    );
  if (rows.length === 0) return;
  const roleIds = [...byKey.values()];
  const roleCapRows = roleIds.length
    ? await db
        .select({
          roleId: teamRoleCapabilitiesTable.roleId,
          capability: teamRoleCapabilitiesTable.capability,
        })
        .from(teamRoleCapabilitiesTable)
        .where(inArray(teamRoleCapabilitiesTable.roleId, roleIds))
    : [];
  const capsByRole = new Map<string, Capability[]>();
  for (const r of roleCapRows) {
    const list = capsByRole.get(r.roleId) ?? [];
    list.push(r.capability as Capability);
    capsByRole.set(r.roleId, list);
  }
  // Adoption compares effective sets, so a hand-picked superset must never be adopted into a scoped role.
  const scopedRoles = new Set(
    roleIds.length
      ? (
          await db
            .select({ id: teamRolesTable.id, scoped: teamRolesTable.scoped })
            .from(teamRolesTable)
            .where(inArray(teamRolesTable.id, roleIds))
        )
          .filter((r) => r.scoped)
          .map((r) => r.id)
      : [],
  );
  const caps = await capabilitiesByMembership(
    db,
    rows.map((r) => r.id),
  );
  for (const m of rows) {
    const targetId = byKey.get(m.role as Role);
    if (!targetId) continue;
    if (
      !sameCapabilities(
        caps.get(m.id) ?? [],
        effectiveRoleCapabilities(
          capsByRole.get(targetId) ?? [],
          scopedRoles.has(targetId),
        ),
      )
    )
      continue;
    await db
      .update(membershipsTable)
      .set({ roleId: targetId })
      .where(eq(membershipsTable.id, m.id));
  }
}

export async function resetRole(id: string): Promise<void> {
  const { teamId, userId, membership } =
    await requireCapability("manage_roles");
  if (await memberScopeFor(userId, teamId))
    throw new Error(
      "Your own role reaches part of this team, so you can't reset a role to full access.",
    );
  let name = "";
  await getDb().transaction(async (tx) => {
    const role = await roleInTeam(tx, teamId, id);
    const key = role.builtinKey as Role | null;
    if (!key)
      throw new Error(
        "Only a default role can be reset - a custom role has no default to go back to.",
      );
    const defaults = ROLE_DEFAULTS[key];
    name = defaults.name;
    const capabilities = withinActor(capabilitiesForRole(key), membership);
    await assertNameFree(tx, teamId, defaults.name, role.id);
    await lockTeamMemberships(tx, teamId);
    await tx
      .update(teamRolesTable)
      .set({
        name: defaults.name,
        description: defaults.description,
        requireTwoFactor: false,
        scoped: false,
      })
      .where(
        and(eq(teamRolesTable.id, role.id), eq(teamRolesTable.teamId, teamId)),
      );
    await writeRoleScope(tx, role.id, null);
    await tx
      .delete(teamRoleCapabilitiesTable)
      .where(eq(teamRoleCapabilitiesTable.roleId, role.id));
    await tx
      .insert(teamRoleCapabilitiesTable)
      .values(capabilities.map((c) => ({ roleId: role.id, capability: c })));
    await syncMembersOfRole(tx, teamId, role.id, capabilities, false);
    await assertTeamAdminCoverage(tx, teamId);
  });
  await recordActivity(
    "member",
    `Reset the ${name} role to its default`,
    await actorName(),
    null,
    teamId,
    "member_access_changed",
  );
}
