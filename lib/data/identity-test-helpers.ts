import {
  memberships,
  membershipCapabilities,
  registrationLinks,
  teams,
  users,
} from "../db/schema/control-plane";
import { capabilitiesForRole } from "../membership-shared";
import { hashPassword, sha256Hex } from "../crypto";
import type { TestDb } from "../db/test-harness";
import type { Capability, Role } from "../types";
import * as store from "../store";

/**
 * Shared seeding for the identity cut-set (b) data-layer tests (relational-store
 * PLAN Step 3). Identity (`users`/`teams`/`memberships`(+capabilities) +
 * `registrationLinks`) is RELATIONAL: the authz backbone and `getCurrentUser`
 * read pglite. So this seeds the relational identity tables directly and resets
 * the JSONB store (any residual JSONB read path — `recordActivity` team fallback,
 * `getUserDetail` activities — sees a clean document).
 *
 * The caller drives the data functions inside `runWithIdentity({userId, teamId})`
 * so the cookie-free principal/team is visible without a request scope.
 *
 * Not named `*.test.ts` so the `node --test` glob skips it (a helper).
 */

export const TEAM_A = "team_a";
export const TEAM_B = "team_b";
export const USER_1 = "user_1";

const T0 = "2026-01-01T00:00:00.000Z";

export interface SeedTeam {
  id: string;
  slug: string;
}
export interface SeedUser {
  id: string;
  teamId: string;
  role?: Role;
  /** Override the capability set (defaults to the role preset). */
  capabilities?: Capability[];
  isInstanceAdmin?: boolean;
  suspended?: boolean;
  /** Plaintext password — hashed on seed. Defaults to "password1". */
  password?: string;
  email?: string;
}

const DEFAULT_TEAMS: SeedTeam[] = [
  { id: TEAM_A, slug: "alpha" },
  { id: TEAM_B, slug: "beta" },
];
const DEFAULT_USERS: SeedUser[] = [{ id: USER_1, teamId: TEAM_A, role: "owner" }];

/** Truncate every identity table (call in `beforeEach` before seeding). */
export const TRUNCATE_IDENTITY = `truncate table
  registration_links, membership_capabilities, memberships, users, teams
  restart identity cascade;`;

/**
 * Seed identity into the relational tables. Defaults to two teams (alpha/beta)
 * and one owner user in alpha — enough for "owner can mutate" + cross-team
 * isolation. Returns the seeded password (hashed in the DB) for login tests.
 */
export async function seedIdentity(
  db: TestDb,
  opts: { teams?: SeedTeam[]; users?: SeedUser[] } = {},
): Promise<void> {
  const seedTeams = opts.teams ?? DEFAULT_TEAMS;
  const seedUsers = opts.users ?? DEFAULT_USERS;

  store.reseed();

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
    seedUsers.map((u) => {
      const role = u.role ?? "owner";
      return {
        id: u.id,
        email: u.email ?? `${u.id}@example.io`,
        username: u.id,
        name: u.id,
        passwordHash: hashPassword(u.password ?? "password1"),
        role,
        isInstanceAdmin: u.isInstanceAdmin ?? role === "owner",
        suspended: u.suspended ?? false,
        avatarColor: "#abc",
        createdAt: T0,
      };
    }),
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

/** Insert a pending registration link; returns the raw token to register with. */
export async function seedRegistrationLink(
  db: TestDb,
  opts: { id?: string; createdBy?: string; expiresAt?: string } = {},
): Promise<string> {
  const rawToken = `tok-${opts.id ?? "reg_1"}-${Math.abs(
    [...(opts.id ?? "reg_1")].reduce((a, c) => a + c.charCodeAt(0), 0),
  )}`;
  await db.insert(registrationLinks).values({
    id: opts.id ?? "reg_1",
    tokenHash: sha256Hex(rawToken),
    status: "pending",
    createdBy: opts.createdBy ?? "admin",
    usedByUsername: null,
    // Far-future default so `expires_at >= now()` holds.
    expiresAt: opts.expiresAt ?? "2099-01-01T00:00:00.000Z",
    createdAt: T0,
    usedAt: null,
  });
  return rawToken;
}
