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

// What a role confers on a membership row: its rank, its effective capabilities, its reach.
export interface RoleAssignment {
  roleId: string;
  // The rank the membership row carries: a custom role ranks as `member`.
  rank: Role;
  capabilities: Capability[];
  name: string;
  // The role reaches part of the team, so its holders never reach all of it.
  scoped: boolean;
}

// roleAssignment - resolve a role id INSIDE the caller's transaction. Throws if the id
// belongs to another team: the cross-team id check every row-targeting write needs.
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
    // A custom role ranks as `member`: only the Owner default outranks, and only
    // rank 'owner' unlocks acting on other owners.
    rank: ((role.builtinKey as Role | null) ?? "member") as Role,
    capabilities: effectiveRoleCapabilities(
      caps.map((c) => c.capability as Capability),
      role.scoped,
    ),
    name: role.name,
    scoped: role.scoped,
  };
}

// matchTeamRole - the role a hand-supplied capability set corresponds to exactly, or
// null when it matches none.
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
  // A SCOPED role is never a candidate, whatever it grants.
  const candidates = rows.filter((r) => !r.scoped);
  // Prefer the built-in named by the rank, so an owner/member/viewer set lands on
  // the role the caller meant even if a custom role happens to grant the same.
  const ordered = [
    ...candidates.filter((r) => r.builtinKey === rank),
    ...candidates.filter((r) => r.builtinKey !== rank),
  ];
  // Compared against the EFFECTIVE set, never the authored one.
  const match = ordered.find((r) =>
    sameCapabilities(
      effectiveRoleCapabilities(capsByRole.get(r.id) ?? [], r.scoped),
      caps,
    ),
  );
  return match ? { id: match.id, name: match.name } : null;
}
