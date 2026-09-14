import "server-only";

import { and, eq, inArray, notInArray } from "drizzle-orm";

import { type DbTx } from "../../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../../db/schema/control-plane/access-control";
import {
  CAPABILITY_META,
  PROJECT_SCOPED_CAPABILITIES,
  boundedBy,
  expandLegacyCapabilities,
  NODE_GRANTABLE_CAPABILITIES,
} from "../../membership-shared";
import { withView } from "../folder-access";
import {
  ALL_CAPABILITIES,
  type Capability,
  type Membership,
} from "../../types/identity";
import { type Db } from "./role-guards";

// Strip these from everyone and the team locks itself out of member/team
// administration irrecoverably. Same list (and reason) as lib/data/members.
const CRITICAL: { cap: Capability; label: string }[] = [
  { cap: "manage_members", label: "manage members" },
  { cap: "manage_roles", label: "manage roles" },
  { cap: "manage_team", label: "manage the team" },
];

// effectiveRoleCapabilities - what a role's capabilities mean once its reach is taken
// into account: the set that lands in `membership_capabilities`, which every check reads.
export function effectiveRoleCapabilities(
  authored: Capability[],
  scoped: boolean,
): Capability[] {
  return withView(
    scoped ? boundedBy(authored, PROJECT_SCOPED_CAPABILITIES) : authored,
  );
}

// capabilitiesByMembership - membershipId → capabilities, in ONE query (never per-membership).
export async function capabilitiesByMembership(
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

// lockTeamMemberships - lock the team's memberships for the rest of the transaction, so
// two concurrent edits serialize instead of both leaving the team with zero admins.
export async function lockTeamMemberships(
  tx: DbTx,
  teamId: string,
): Promise<void> {
  await tx
    .select({ id: membershipsTable.id })
    .from(membershipsTable)
    .where(eq(membershipsTable.teamId, teamId))
    .for("update");
}

// assertTeamAdminCoverage - the team still has a holder of each critical capability.
// Runs inside the transaction (so it sees the write) and throws to roll it back.
export async function assertTeamAdminCoverage(
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

// syncMembersOfRole - re-write the effective capabilities of every member holding this
// role, bar the ones whose set is their OWN (`memberships.custom_capabilities`).
export async function syncMembersOfRole(
  tx: DbTx,
  teamId: string,
  roleId: string,
  authored: Capability[],
  scoped: boolean,
): Promise<number> {
  const caps = effectiveRoleCapabilities(authored, scoped);
  // A holder who keeps their own set is narrowed with the role's reach all the
  // same: the reach and the capabilities have to agree, whoever wrote the set.
  if (scoped) {
    const custom = await tx
      .select({ id: membershipsTable.id })
      .from(membershipsTable)
      .where(
        and(
          eq(membershipsTable.teamId, teamId),
          eq(membershipsTable.roleId, roleId),
          eq(membershipsTable.customCapabilities, true),
        ),
      );
    if (custom.length > 0)
      await tx.delete(membershipCapabilitiesTable).where(
        and(
          inArray(
            membershipCapabilitiesTable.membershipId,
            custom.map((m) => m.id),
          ),
          notInArray(
            membershipCapabilitiesTable.capability,
            NODE_GRANTABLE_CAPABILITIES,
          ),
        ),
      );
  }
  const members = await tx
    .select({ id: membershipsTable.id })
    .from(membershipsTable)
    .where(
      and(
        eq(membershipsTable.teamId, teamId),
        eq(membershipsTable.roleId, roleId),
        eq(membershipsTable.customCapabilities, false),
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

// Known capabilities only, `view` always included (it is the floor). A retired coarse
// name arriving from an API client expands rather than being dropped on the floor.
function sanitizeCapabilities(caps: Capability[] | undefined): Capability[] {
  const set = new Set(expandLegacyCapabilities((caps ?? []) as string[]));
  set.add("view");
  return ALL_CAPABILITIES.filter((c) => set.has(c));
}

// withinActor - a caller can only put capabilities they hold THEMSELVES into a role (or
// an API token): otherwise a `manage_members` holder could author an all-powerful role.
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
