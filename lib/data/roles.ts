import "server-only";

import { and, asc, count, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { getDb, type DbTx } from "../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  teamRoles as teamRolesTable,
  teamRoleCapabilities as teamRoleCapabilitiesTable,
  users as usersTable,
} from "../db/schema/control-plane";
import { newId, nowIso } from "../ids";
import { getCurrentUser } from "../auth";
import { recordActivity } from "./activity";
import { requireActiveTeamId, requireCapability, requireUnscoped } from "../membership";
import {
  BUILTIN_ROLE_KEYS,
  CAPABILITY_META,
  expandLegacyCapabilities,
  CAPABILITY_PRESETS,
  ROLE_DEFAULTS,
  capabilitiesForRole,
  sameCapabilities,
} from "../membership-shared";
import { withView } from "./folder-access";
import { ALL_CAPABILITIES, type Capability, type Membership, type Role } from "../types";

/**
 * Team roles — the named capability sets a member is assigned.
 *
 * A role is the SOURCE of a member's capabilities, never a second copy of them:
 * `membership_capabilities` stays the effective set every authorization check in
 * the codebase reads, and every write here re-syncs it for the role's members
 * inside the same transaction. Nothing in the enforcement path had to learn what
 * a role is.
 *
 * Three built-ins (`builtinKey`) are seeded per team by {@link ensureTeamRoles},
 * lazily and idempotently, so a team created by any path — the setup wizard,
 * `createTeam`, a test seeder — has them on first read. They can be renamed and
 * re-scoped and then reset to their shipped default; they can never be deleted.
 * The `owner` built-in is the one exception: it always grants everything, because
 * the founder's rank is immutable by rule and a team that edits its own Owner
 * role into a corner has no way back.
 */

/** A team role as shown in Settings → Team → Roles. */
export interface TeamRoleDTO {
  id: string;
  name: string;
  description: string | null;
  /** 'owner' | 'member' | 'viewer' for a default role, null for a custom one. */
  builtinKey: Role | null;
  capabilities: Capability[];
  /**
   * Holders of this role must have two-factor authentication. A POLICY, not a
   * capability: capabilities answer "may they do X", this answers "under what
   * condition does any of it count". Unmet, the member resolves nothing at all.
   */
  requireTwoFactor: boolean;
  /** How many members of the team currently hold this role. */
  memberCount: number;
  /** A default role that no longer matches its shipped preset — offer "Reset". */
  modified: boolean;
  /** Full access, not editable: the Owner default (see the module comment). */
  locked: boolean;
  createdAt: string;
}

type Db = ReturnType<typeof getDb> | DbTx;

/**
 * Capabilities a team must never be left with zero holders of. Same list (and
 * same reason) as `lib/data/members.ts`: strip them from everyone and the team
 * locks itself out of member/team administration irrecoverably.
 */
const CRITICAL: { cap: Capability; label: string }[] = [
  { cap: "manage_members", label: "manage members" },
  { cap: "manage_roles", label: "manage roles" },
  { cap: "manage_team", label: "manage the team" },
];

/* ------------------------------------------------------------------ */
/* Seeding                                                             */
/* ------------------------------------------------------------------ */

/**
 * Make sure a team has its three built-in roles, and adopt the memberships that
 * belong to one. Idempotent, cheap (two indexed SELECTs on the steady state) and
 * safe to call from any read path — it is what makes every team-creation path
 * (the setup wizard, `createTeam`, a registration link, a test seeder) end up
 * with roles without any of them having to know roles exist.
 *
 * Adoption is deliberately conservative: a membership picks up a built-in only
 * when its rank AND its exact capability set already match that role's preset.
 * Anything else keeps `role_id` NULL ("Custom"), which is the truth — a
 * hand-picked set that belongs to no role. Nobody's effective capabilities change
 * here, in either direction.
 *
 * Returns built-in key → role id, so a caller creating a membership in the same
 * transaction can assign one straight away.
 */
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
    // A concurrent first read of the same team races us; the partial unique
    // index on (team_id, builtin_key) decides, and the loser simply re-reads.
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
      .values(capabilitiesForRole(key).map((c) => ({ roleId: id, capability: c })));
    byKey.set(key, id);
  }

  await adoptMatchingMemberships(db, teamId, byKey);
  return byKey;
}

/**
 * Point role-less memberships at the built-in of their rank when they already
 * grant exactly what it grants TODAY (the team's live role, not the shipped
 * preset — a team that re-scoped its Member role must not have strangers adopted
 * into it). Only ever changes `role_id`; capabilities are read, never written.
 */
async function adoptMatchingMemberships(
  db: Db,
  teamId: string,
  byKey: Map<Role, string>,
): Promise<void> {
  const rows = await db
    .select({ id: membershipsTable.id, role: membershipsTable.role })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.teamId, teamId),
        isNull(membershipsTable.roleId),
      ),
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
  const caps = await capabilitiesByMembership(db, rows.map((r) => r.id));
  for (const m of rows) {
    const targetId = byKey.get(m.role as Role);
    if (!targetId) continue;
    if (!sameCapabilities(caps.get(m.id) ?? [], capsByRole.get(targetId) ?? []))
      continue;
    await db
      .update(membershipsTable)
      .set({ roleId: targetId })
      .where(eq(membershipsTable.id, m.id));
  }
}

/** membershipId → capabilities, in ONE query (never per-membership). */
async function capabilitiesByMembership(
  db: Db,
  membershipIds: string[],
): Promise<Map<string, Capability[]>> {
  const byId = new Map<string, Capability[]>();
  if (membershipIds.length === 0) return byId;
  const rows = await db
    .select({
      membershipId: membershipCapabilitiesTable.membershipId,
      capability: membershipCapabilitiesTable.capability,
    })
    .from(membershipCapabilitiesTable)
    .where(inArray(membershipCapabilitiesTable.membershipId, membershipIds));
  for (const r of rows) {
    const list = byId.get(r.membershipId) ?? [];
    list.push(r.capability as Capability);
    byId.set(r.membershipId, list);
  }
  return byId;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

/** Every role of the active team: defaults first, then custom roles by age. */
export async function listRoles(): Promise<TeamRoleDTO[]> {
  requireUnscoped("roles");
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
  const countByRole = new Map(
    counts.filter((c) => c.roleId).map((c) => [c.roleId as string, Number(c.n)]),
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
      modified: builtinKey
        ? r.name !== ROLE_DEFAULTS[builtinKey].name ||
          (r.description ?? "") !== ROLE_DEFAULTS[builtinKey].description ||
          !sameCapabilities(capabilities, CAPABILITY_PRESETS[builtinKey])
        : false,
      locked: builtinKey === "owner",
      createdAt: r.createdAt,
    };
  });

  // Defaults in their canonical order (Owner, Member, Viewer), then the team's
  // own roles oldest-first — the order the Roles page reads top to bottom.
  const rank = (d: TeamRoleDTO) =>
    d.builtinKey ? BUILTIN_ROLE_KEYS.indexOf(d.builtinKey) : BUILTIN_ROLE_KEYS.length;
  return dtos.sort((a, b) => rank(a) - rank(b));
}

/**
 * One role of the active team, or null when the id belongs to another team (or
 * to nothing) — the role editor page's loader. Reads through {@link listRoles} so
 * the DTO, the member count and the "modified" verdict are computed in exactly
 * one place; the team has at most a few dozen roles, so the extra rows cost
 * nothing next to a second set of near-identical queries that could drift.
 */
export async function getRole(id: string): Promise<TeamRoleDTO | null> {
  return (await listRoles()).find((r) => r.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* Helpers shared with the membership writes                           */
/* ------------------------------------------------------------------ */

export interface RoleAssignment {
  roleId: string;
  /** The rank the membership row carries: a custom role ranks as `member`. */
  rank: Role;
  capabilities: Capability[];
  name: string;
}

/**
 * Resolve a role id INSIDE the caller's transaction: its rank and the exact
 * capability set to write onto the membership. Throws if the id belongs to
 * another team — the cross-team id check every row-targeting write needs.
 */
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
    capabilities: withView(caps.map((c) => c.capability as Capability)),
    name: role.name,
  };
}

/**
 * The role a hand-supplied capability set corresponds to exactly, or null when it
 * matches none. Lets the legacy `role` + `capabilities` write path (the public
 * API, registration links) still land on a real role instead of showing up as a
 * "Custom" membership nobody chose.
 */
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
  // Prefer the built-in named by the rank, so an owner/member/viewer set lands on
  // the role the caller meant even if a custom role happens to grant the same.
  const ordered = [
    ...rows.filter((r) => r.builtinKey === rank),
    ...rows.filter((r) => r.builtinKey !== rank),
  ];
  const match = ordered.find((r) =>
    sameCapabilities(capsByRole.get(r.id) ?? [], caps),
  );
  return match ? { id: match.id, name: match.name } : null;
}

/**
 * Lock the team's memberships for the rest of the transaction, so two concurrent
 * edits (a role re-scope and a member reassignment) serialize instead of both
 * reading a pre-change world and leaving the team with zero admins.
 */
async function lockTeamMemberships(tx: DbTx, teamId: string): Promise<void> {
  await tx
    .select({ id: membershipsTable.id })
    .from(membershipsTable)
    .where(eq(membershipsTable.teamId, teamId))
    .for("update");
}

/**
 * After a write, assert the team still has at least one holder of each critical
 * capability. Runs inside the transaction (so it sees the write) and throws to
 * roll the whole thing back.
 */
async function assertTeamAdminCoverage(
  tx: DbTx,
  teamId: string,
): Promise<void> {
  for (const { cap, label } of CRITICAL) {
    const holders = await tx
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
      )
      .limit(1);
    if (holders.length === 0)
      throw new Error(
        `The team must keep at least one member who can ${label}`,
      );
  }
}

/** Re-write the effective capabilities of every member holding this role. */
async function syncMembersOfRole(
  tx: DbTx,
  teamId: string,
  roleId: string,
  caps: Capability[],
): Promise<number> {
  const members = await tx
    .select({ id: membershipsTable.id })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.teamId, teamId),
        eq(membershipsTable.roleId, roleId),
      ),
    );
  if (members.length === 0) return 0;
  const ids = members.map((m) => m.id);
  await tx
    .delete(membershipCapabilitiesTable)
    .where(inArray(membershipCapabilitiesTable.membershipId, ids));
  await tx
    .insert(membershipCapabilitiesTable)
    .values(
      ids.flatMap((membershipId) =>
        caps.map((capability) => ({ membershipId, capability })),
      ),
    );
  return ids.length;
}

/** One role of THIS team, or a clear error. Never leaks another team's rows. */
async function roleInTeam(
  db: Db,
  teamId: string,
  roleId: string,
): Promise<{
  id: string;
  builtinKey: string | null;
  name: string;
  description: string | null;
}> {
  const rows = await db
    .select({
      id: teamRolesTable.id,
      builtinKey: teamRolesTable.builtinKey,
      name: teamRolesTable.name,
      description: teamRolesTable.description,
    })
    .from(teamRolesTable)
    .where(and(eq(teamRolesTable.id, roleId), eq(teamRolesTable.teamId, teamId)))
    .limit(1);
  const role = rows[0];
  if (!role) throw new Error("Role not found");
  return role;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const MAX_NAME = 40;
const MAX_DESCRIPTION = 160;

function cleanRoleName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new Error("Give the role a name");
  if (name.length > MAX_NAME)
    throw new Error(`Keep the role name under ${MAX_NAME} characters`);
  return name;
}

function cleanDescription(raw: string | undefined | null): string | null {
  const text = (raw ?? "").trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (text.length > MAX_DESCRIPTION)
    throw new Error(`Keep the description under ${MAX_DESCRIPTION} characters`);
  return text;
}

/**
 * Known capabilities only, `view` always included (it is the floor). One of the
 * eight retired coarse names arriving from an API client expands to the
 * permissions it used to imply rather than being dropped on the floor.
 */
function sanitizeCapabilities(caps: Capability[] | undefined): Capability[] {
  const set = new Set(expandLegacyCapabilities((caps ?? []) as string[]));
  set.add("view");
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

/**
 * A caller can only put capabilities they hold THEMSELVES into a role (or an
 * API token) — without it, a plain `manage_members` holder could author an
 * all-powerful role and hand it out, and a `manage_tokens` holder could mint a
 * token more powerful than themselves. Unlike the member-level clamp this
 * REFUSES rather than silently dropping: an editor that saves fewer permissions
 * than were ticked, with no explanation, is how an admin ends up believing a
 * role grants something it doesn't.
 *
 * The bound is the actor's CAPABILITIES, never their rank. `memberships.role` is
 * only a rank, and it is the one part of a membership the API-token clamp does
 * not narrow — so exempting rank `owner` here meant an owner's token restricted
 * to `manage_tokens` could mint an all-powerful successor, and one restricted to
 * `manage_roles` could re-scope the role every member already holds. A real
 * owner holds all forty-one capabilities, so the bound costs them nothing; what
 * it costs is that escalation. Same reason the assignment path in
 * `lib/data/members.ts` dropped its own rank exemption.
 *
 * Shared with `lib/data/tokens.ts` — `subject` only names the thing in the
 * error, the rule is identical. It also carries `sanitizeCapabilities` along, so
 * a retired coarse name arriving from an API client expands on both paths.
 */
export function withinActor(
  caps: Capability[] | undefined,
  actor: Membership,
  subject: "role" | "token" = "role",
): Capability[] {
  const wanted = sanitizeCapabilities(caps);
  const beyond = wanted.filter((c) => !actor.capabilities.includes(c));
  if (beyond.length > 0)
    throw new Error(
      `You can only give a ${subject} permissions you hold yourself: ${beyond
        .map((c) => CAPABILITY_META[c].label.toLowerCase())
        .join(", ")}`,
    );
  return withView(wanted);
}

/** Refuse a name another role of the team already uses (case-insensitively). */
async function assertNameFree(
  tx: DbTx,
  teamId: string,
  name: string,
  exceptRoleId: string | null,
): Promise<void> {
  const rows = await tx
    .select({ id: teamRolesTable.id, name: teamRolesTable.name })
    .from(teamRolesTable)
    .where(eq(teamRolesTable.teamId, teamId));
  const clash = rows.find(
    (r) =>
      r.id !== exceptRoleId && r.name.toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new Error(`This team already has a role called “${name}”`);
}

async function actorUsername(): Promise<string> {
  return (await getCurrentUser())?.username ?? "an admin";
}

/**
 * Refuse to put a 2FA mandate on a role the actor HOLDS while the actor has no
 * second factor. They would be answering their own next request with a refusal —
 * survivable in the dashboard (the lock screen offers enrolment) but a dead end
 * over the bearer API, where the token that made the change is the token the
 * change kills.
 */
async function assertActorCanMandateTwoFactor(
  userId: string,
  roleId: string,
): Promise<void> {
  const db = getDb();
  const me = (
    await db
      .select({ enabled: usersTable.twoFactorEnabled })
      .from(usersTable)
      .where(eq(usersTable.id, userId))
      .limit(1)
  )[0];
  if (me?.enabled) return;
  const holds = await db
    .select({ id: membershipsTable.id })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.userId, userId),
        eq(membershipsTable.roleId, roleId),
      ),
    )
    .limit(1);
  if (holds.length > 0)
    throw new Error(
      "You hold this role, so turn on two-factor authentication for your own account first.",
    );
}

/* ------------------------------------------------------------------ */
/* Mutations                                                           */
/* ------------------------------------------------------------------ */

/** Create a custom role for the active team. */
export async function createRole(input: {
  name: string;
  description?: string | null;
  capabilities?: Capability[];
  requireTwoFactor?: boolean;
}): Promise<TeamRoleDTO> {
  const { teamId, membership } = await requireCapability("manage_roles");
  const name = cleanRoleName(input.name);
  const description = cleanDescription(input.description);
  const capabilities = withinActor(input.capabilities, membership);
  // No self-lockout check on create: a brand-new role has no members yet, so
  // turning the mandate on cannot cut anyone off, the author included.
  const requireTwoFactor = input.requireTwoFactor ?? false;
  const db = getDb();
  await ensureTeamRoles(db, teamId);

  const id = newId("role");
  const createdAt = nowIso();
  await db.transaction(async (tx) => {
    await assertNameFree(tx, teamId, name, null);
    await tx
      .insert(teamRolesTable)
      .values({
        id,
        teamId,
        builtinKey: null,
        name,
        description,
        requireTwoFactor,
        createdAt,
      });
    await tx
      .insert(teamRoleCapabilitiesTable)
      .values(capabilities.map((c) => ({ roleId: id, capability: c })));
  });
  await recordActivity(
    "member",
    `Created the ${name} role`,
    await actorUsername(),
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
    createdAt,
  };
}

/**
 * Rename and/or re-scope a role. Every member holding it gets the new capability
 * set in the SAME transaction — a role is what its members can do, not a preset
 * that drifts away from them the moment it is edited.
 */
export async function updateRole(input: {
  id: string;
  name: string;
  description?: string | null;
  capabilities?: Capability[];
  requireTwoFactor?: boolean;
}): Promise<void> {
  const { teamId, userId, membership } = await requireCapability("manage_roles");
  const name = cleanRoleName(input.name);
  const description = cleanDescription(input.description);
  const capabilities = withinActor(input.capabilities, membership);
  const requireTwoFactor = input.requireTwoFactor ?? false;
  if (requireTwoFactor) await assertActorCanMandateTwoFactor(userId, input.id);

  await getDb().transaction(async (tx) => {
    const role = await roleInTeam(tx, teamId, input.id);
    if (role.builtinKey === "owner")
      throw new Error(
        "The Owner role always has full access and can't be edited.",
      );
    await assertNameFree(tx, teamId, name, role.id);
    await lockTeamMemberships(tx, teamId);
    await tx
      .update(teamRolesTable)
      .set({ name, description, requireTwoFactor })
      .where(
        and(eq(teamRolesTable.id, role.id), eq(teamRolesTable.teamId, teamId)),
      );
    await tx
      .delete(teamRoleCapabilitiesTable)
      .where(eq(teamRoleCapabilitiesTable.roleId, role.id));
    await tx
      .insert(teamRoleCapabilitiesTable)
      .values(capabilities.map((c) => ({ roleId: role.id, capability: c })));
    await syncMembersOfRole(tx, teamId, role.id, capabilities);
    await assertTeamAdminCoverage(tx, teamId);
  });
  await recordActivity(
    "member",
    `Updated the ${name} role`,
    await actorUsername(),
    null,
    teamId,
  );
}

/** Restore a default role to exactly what deplo ships. Built-ins only. */
export async function resetRole(id: string): Promise<void> {
  const { teamId, membership } = await requireCapability("manage_roles");
  let name = "";
  await getDb().transaction(async (tx) => {
    const role = await roleInTeam(tx, teamId, id);
    const key = role.builtinKey as Role | null;
    if (!key)
      throw new Error(
        "Only a default role can be reset — a custom role has no default to go back to.",
      );
    const defaults = ROLE_DEFAULTS[key];
    name = defaults.name;
    // Bounded exactly like authoring the same role by hand (`updateRole`). A
    // reset rewrites the capabilities of everyone holding the role — the actor
    // included — so without this a `manage_roles` holder whose own role had been
    // narrowed could widen it back to the shipped preset in one call.
    const capabilities = withinActor(capabilitiesForRole(key), membership);
    await assertNameFree(tx, teamId, defaults.name, role.id);
    await lockTeamMemberships(tx, teamId);
    await tx
      .update(teamRolesTable)
      .set({
        name: defaults.name,
        description: defaults.description,
        // A shipped default mandates nothing; "reset" means all the way back.
        requireTwoFactor: false,
      })
      .where(
        and(eq(teamRolesTable.id, role.id), eq(teamRolesTable.teamId, teamId)),
      );
    await tx
      .delete(teamRoleCapabilitiesTable)
      .where(eq(teamRoleCapabilitiesTable.roleId, role.id));
    await tx
      .insert(teamRoleCapabilitiesTable)
      .values(capabilities.map((c) => ({ roleId: role.id, capability: c })));
    await syncMembersOfRole(tx, teamId, role.id, capabilities);
    await assertTeamAdminCoverage(tx, teamId);
  });
  await recordActivity(
    "member",
    `Reset the ${name} role to its default`,
    await actorUsername(),
    null,
    teamId,
  );
}

/**
 * Delete a custom role. Refuses while anyone still holds it — reassigning those
 * members is a decision, not something a delete should make silently (and the FK
 * is RESTRICT, so the database refuses too).
 */
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
    await actorUsername(),
    null,
    teamId,
  );
}
