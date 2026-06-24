import { teams, users } from "../db/schema/control-plane";
import { capabilitiesForRole } from "../membership-shared";
import type { TestDb } from "../db/test-harness";
import type { Role } from "../types";
import * as store from "../store";

/**
 * Shared seeding for the leaf cut-set data-layer tests (relational-store PLAN
 * Step 2). In Step 2 only the four leaf collections live in Postgres; identity
 * (`users`/`teams`/`memberships`) is still the JSONB store (cut-set b). So a test
 * that drives a `requireCapability`-gated leaf function must seed BOTH:
 *
 *  - the JSONB store with a user + team + membership (so `requireActiveTeamId` /
 *    `requireCapability` resolve — these still read `read()`), and
 *  - the pglite FK roots `teams`/`users` (so the leaf rows' NOT-NULL
 *    `team_id`/`user_id` FKs resolve).
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
 * Seed identity into BOTH the JSONB store and the pglite FK roots. Defaults to
 * two teams (alpha/beta) and one owner user in alpha — enough for "owner can
 * mutate" + "cross-team isolation" assertions. Call in `beforeEach` AFTER
 * truncating and AFTER `store.reseed()`.
 */
export async function seedIdentity(
  db: TestDb,
  opts: { teams?: SeedTeam[]; users?: SeedUser[] } = {},
): Promise<void> {
  const seedTeams = opts.teams ?? DEFAULT_TEAMS;
  const seedUsers = opts.users ?? DEFAULT_USERS;

  store.reseed();
  store.mutate((d) => {
    for (const t of seedTeams) {
      d.teams.push({
        id: t.id,
        name: t.slug,
        slug: t.slug,
        plan: "pro",
        createdAt: T0,
      });
    }
    for (const u of seedUsers) {
      const role = u.role ?? "owner";
      d.users.push({
        id: u.id,
        email: `${u.id}@example.io`,
        username: u.id,
        name: u.id,
        passwordHash: "h",
        role,
        isInstanceAdmin: role === "owner",
        avatarColor: "#abc",
        createdAt: T0,
      });
      d.memberships.push({
        id: `mem_${u.id}`,
        userId: u.id,
        teamId: u.teamId,
        role,
        capabilities: capabilitiesForRole(role),
        createdAt: T0,
      });
    }
  });

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
}
