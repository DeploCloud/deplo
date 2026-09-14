import "server-only";

import { asc, count, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  memberships as membershipsTable,
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
} from "../../db/schema/control-plane/access-control";
import { requireActiveTeamId, requireTeamWide } from "../../membership";
import {
  BUILTIN_ROLE_KEYS,
  CAPABILITY_PRESETS,
  ROLE_DEFAULTS,
  sameCapabilities,
} from "../../membership-shared";
import {
  ALL_CAPABILITIES,
  type Capability,
  type Role,
} from "../../types/identity";
import { ensureTeamRoles } from "./builtin-roles";
import { EMPTY_SCOPE, loadRoleScopes, type ResolvedScope } from "./scope";

// A team role as shown in Settings → Team → Roles.
export interface TeamRoleDTO {
  id: string;
  name: string;
  description: string | null;
  // 'owner' | 'member' | 'viewer' for a default role, null for a custom one.
  builtinKey: Role | null;
  capabilities: Capability[];
  // A POLICY, not a capability: unmet, the member resolves nothing at all.
  requireTwoFactor: boolean;
  memberCount: number;
  // A default role that no longer matches its shipped preset - offer "Reset".
  modified: boolean;
  // Full access, not editable: the Owner default.
  locked: boolean;
  // What the role REACHES, or null when it reaches the whole team. Distinct from
  // `capabilities`: that is what its holders may DO, this is where.
  scope: ResolvedScope | null;
  createdAt: string;
}

// listRoles - every role of the active team: defaults first, then custom roles by age.
export async function listRoles(): Promise<TeamRoleDTO[]> {
  await requireTeamWide("roles");
  const teamId = await requireActiveTeamId();
  const db = getDb();
  await ensureTeamRoles(db, teamId);

  const rows = await db
    .select({
      id: teamRolesTable.id,
      builtinKey: teamRolesTable.builtinKey,
      name: teamRolesTable.name,
      description: teamRolesTable.description,
      requireTwoFactor: teamRolesTable.requireTwoFactor,
      scoped: teamRolesTable.scoped,
      createdAt: teamRolesTable.createdAt,
    })
    .from(teamRolesTable)
    .where(eq(teamRolesTable.teamId, teamId))
    .orderBy(asc(teamRolesTable.createdAt));
  if (rows.length === 0) return [];

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
  const capsByRole = new Map<string, Capability[]>();
  for (const r of capRows) {
    const list = capsByRole.get(r.roleId) ?? [];
    list.push(r.capability as Capability);
    capsByRole.set(r.roleId, list);
  }

  const counts = await db
    .select({ roleId: membershipsTable.roleId, n: count() })
    .from(membershipsTable)
    .where(eq(membershipsTable.teamId, teamId))
    .groupBy(membershipsTable.roleId);
  const scopedIds = rows.filter((r) => r.scoped).map((r) => r.id);
  const scopeByRole = await loadRoleScopes(db, scopedIds);
  const countByRole = new Map(
    counts
      .filter((c) => c.roleId)
      .map((c) => [c.roleId as string, Number(c.n)]),
  );

  const dtos = rows.map((r) => {
    const builtinKey = (r.builtinKey ?? null) as Role | null;
    const capabilities = ALL_CAPABILITIES.filter((c) =>
      (capsByRole.get(r.id) ?? []).includes(c),
    );
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      builtinKey,
      capabilities,
      requireTwoFactor: r.requireTwoFactor ?? false,
      memberCount: countByRole.get(r.id) ?? 0,
      // Both axes, not just power.
      modified: builtinKey
        ? r.scoped ||
          (r.requireTwoFactor ?? false) ||
          r.name !== ROLE_DEFAULTS[builtinKey].name ||
          (r.description ?? "") !== ROLE_DEFAULTS[builtinKey].description ||
          !sameCapabilities(capabilities, CAPABILITY_PRESETS[builtinKey])
        : false,
      locked: builtinKey === "owner",
      scope: r.scoped ? (scopeByRole.get(r.id) ?? EMPTY_SCOPE) : null,
      createdAt: r.createdAt,
    };
  });

  const rank = (d: TeamRoleDTO) =>
    d.builtinKey
      ? BUILTIN_ROLE_KEYS.indexOf(d.builtinKey)
      : BUILTIN_ROLE_KEYS.length;
  return dtos.sort((a, b) => rank(a) - rank(b));
}

// getRole - one role of the active team, or null when the id belongs to another team
// (or to nothing) - the role editor page's loader.
export async function getRole(id: string): Promise<TeamRoleDTO | null> {
  return (await listRoles()).find((r) => r.id === id) ?? null;
}
