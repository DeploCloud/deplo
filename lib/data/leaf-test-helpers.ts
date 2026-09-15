import {
  memberships,
  membershipCapabilities,
} from "../db/schema/control-plane/access-control";
import { teams, users } from "../db/schema/control-plane/identity";
import { capabilitiesForRole } from "../membership-shared";
import type { TestDb } from "../db/test-harness";
import type { Capability, Role } from "../types/identity";

export const TEAM_A = "team_a";
export const TEAM_B = "team_b";
export const USER_1 = "user_1";

const T0 = "2026-01-01T00:00:00.000Z";

interface SeedTeam {
  id: string;
  slug: string;
  mcpEnabled?: boolean;
}
interface SeedUser {
  id: string;
  teamId: string;
  role?: Role;
  capabilities?: Capability[];
}

const DEFAULT_TEAMS: SeedTeam[] = [
  { id: TEAM_A, slug: "alpha" },
  { id: TEAM_B, slug: "beta" },
];
const DEFAULT_USERS: SeedUser[] = [
  { id: USER_1, teamId: TEAM_A, role: "owner" },
];

export async function seedIdentity(
  db: TestDb,
  opts: { teams?: SeedTeam[]; users?: SeedUser[] } = {},
): Promise<void> {
  const seedTeams = opts.teams ?? DEFAULT_TEAMS;
  const seedUsers = opts.users ?? DEFAULT_USERS;

  await db.insert(teams).values(
    seedTeams.map((t) => ({
      id: t.id,
      name: t.slug,
      slug: t.slug,
      plan: "pro" as const,
      mcpEnabled: t.mcpEnabled ?? true,
      createdAt: T0,
    })),
  );
  await db.insert(users).values(
    seedUsers.map((u) => ({
      id: u.id,
      email: `${u.id}@example.io`,
      username: u.id,
      name: u.id,
      role: u.role ?? "owner",
      isInstanceAdmin: (u.role ?? "owner") === "owner",
      avatarColor: "#abc",
      createdAt: T0,
      updatedAt: T0,
    })),
  );
  await db.insert(memberships).values(
    seedUsers.map((u) => ({
      id: `mem_${u.id}`,
      userId: u.id,
      teamId: u.teamId,
      role: u.role ?? "owner",
      createdAt: T0,
    })),
  );
  const caps = seedUsers.flatMap((u) =>
    (u.capabilities ?? capabilitiesForRole(u.role ?? "owner")).map((c) => ({
      membershipId: `mem_${u.id}`,
      capability: c,
    })),
  );
  if (caps.length > 0) await db.insert(membershipCapabilities).values(caps);
}
