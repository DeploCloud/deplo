import "server-only";

import { eq, inArray } from "drizzle-orm";

import {
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
} from "../../db/schema/control-plane/access-control";
import { sameCapabilities } from "../../membership-shared";
import { type Capability, type Role } from "../../types/identity";
import { roleInTeam, type Db } from "./role-guards";
import { effectiveRoleCapabilities } from "./member-capabilities";

export interface RoleAssignment {
  roleId: string;
  rank: Role;
  capabilities: Capability[];
  name: string;
  scoped: boolean;
}

export async function roleAssignment(
  db: Db,
  teamId: string,
  roleId: string,
): Promise<RoleAssignment> {
  const role = await roleInTeam(db, teamId, roleId);
  const caps = await db
    .select({ capability: teamRoleCapabilitiesTable.capability })
    .from(teamRoleCapabilitiesTable)
    .where(eq(teamRoleCapabilitiesTable.roleId, roleId));
  return {
    roleId: role.id,
    rank: ((role.builtinKey as Role | null) ?? "member") as Role,
    capabilities: effectiveRoleCapabilities(
      caps.map((c) => c.capability as Capability),
      role.scoped,
    ),
    name: role.name,
    scoped: role.scoped,
  };
}

export async function matchTeamRole(
  db: Db,
  teamId: string,
  rank: Role,
  caps: Capability[],
): Promise<{ id: string; name: string } | null> {
  const rows = await db
    .select({
      id: teamRolesTable.id,
      name: teamRolesTable.name,
      builtinKey: teamRolesTable.builtinKey,
      scoped: teamRolesTable.scoped,
    })
    .from(teamRolesTable)
    .where(eq(teamRolesTable.teamId, teamId));
  if (rows.length === 0) return null;
  const capsByRole = new Map<string, Capability[]>();
  const capRows = await db
    .select({
      roleId: teamRoleCapabilitiesTable.roleId,
      capability: teamRoleCapabilitiesTable.capability,
    })
    .from(teamRoleCapabilitiesTable)
    .where(
      inArray(
        teamRoleCapabilitiesTable.roleId,
        rows.map((r) => r.id),
      ),
    );
  for (const r of capRows) {
    const list = capsByRole.get(r.roleId) ?? [];
    list.push(r.capability as Capability);
    capsByRole.set(r.roleId, list);
  }
  const candidates = rows.filter((r) => !r.scoped);
  const ordered = [
    ...candidates.filter((r) => r.builtinKey === rank),
    ...candidates.filter((r) => r.builtinKey !== rank),
  ];
  const match = ordered.find((r) =>
    sameCapabilities(
      effectiveRoleCapabilities(capsByRole.get(r.id) ?? [], r.scoped),
      caps,
    ),
  );
  return match ? { id: match.id, name: match.name } : null;
}
