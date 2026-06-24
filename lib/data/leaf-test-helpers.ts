import {
  memberships,
  membershipCapabilities,
  teams,
  users,
} from "../db/schema/control-plane";
import { capabilitiesForRole } from "../membership-shared";
import type { TestDb } from "../db/test-harness";
import type { Role } from "../types";

/**
 * Shared seeding for the leaf cut-set data-layer tests (relational-store PLAN
 * Step 2). The whole control plane is relational now (Step 6 deleted the JSONB
 * `read`/`mutate`): `requireActiveTeamId`/`requireCapability`/`getCurrentUser`
 * read pglite, and a `requireCapability`-gated leaf function resolves its
 * NOT-NULL `team_id`/`user_id` FKs against the seeded `teams`/`users`. So this
 * seeds ONLY the relational identity tables — there is no JSONB store left to
 * reset.
 *
 * The caller drives the data functions inside `runWithIdentity({userId, teamId})`
 * so the cookie-free principal/team is visible without a request scope.
 *
 * Not named `*.test.ts` so the `node --test` glob skips it (a helper, like
 * `test-harness.ts`).
 */

export const TEAM_A = "team_a";
export const TEAM_B = "team_b";
export const USER_1 = "user_1";

const T0 = "2026-01-01T00:00:00.000Z";

interface SeedTeam {
  id: string;
  slug: string;
}
interface SeedUser {
  id: string;
  teamId: string;
  role?: Role;
}

const DEFAULT_TEAMS: SeedTeam[] = [
  { id: TEAM_A, slug: "alpha" },
  { id: TEAM_B, slug: "beta" },
];
const DEFAULT_USERS: SeedUser[] = [{ id: USER_1, teamId: TEAM_A, role: "owner" }];

/**
 * Seed identity into the pglite FK roots. Defaults to two teams (alpha/beta) and
 * one owner user in alpha — enough for "owner can mutate" + "cross-team
 * isolation" assertions. Call in `beforeEach` AFTER truncating.
 */
export async function seedIdentity(
  db: TestDb,
  opts: { teams?: SeedTeam[]; users?: SeedUser[] } = {},
): Promise<void> {
  const seedTeams = opts.teams ?? DEFAULT_TEAMS;
  const seedUsers = opts.users ?? DEFAULT_USERS;

  // FK roots in pglite.
  await db.insert(teams).values(
    seedTeams.map((t) => ({
      id: t.id,
      name: t.slug,
      slug: t.slug,
      plan: "pro" as const,
      createdAt: T0,
    })),
  );
  await db.insert(users).values(
    seedUsers.map((u) => ({
      id: u.id,
      email: `${u.id}@example.io`,
      username: u.id,
      name: u.id,
      passwordHash: "h",
      role: u.role ?? "owner",
      isInstanceAdmin: (u.role ?? "owner") === "owner",
      avatarColor: "#abc",
      createdAt: T0,
    })),
  );
  // Memberships + capabilities are relational as of cut-set (b): the authz
  // backbone (`membershipFor`/`teamsForUser`/`requireCapability`) reads them.
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
    capabilitiesForRole(u.role ?? "owner").map((c) => ({
      membershipId: `mem_${u.id}`,
      capability: c,
    })),
  );
  if (caps.length > 0) await db.insert(membershipCapabilities).values(caps);
}
