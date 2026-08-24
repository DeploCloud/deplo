import {
  memberships,
  membershipCapabilities,
  registrationLinks,
  teams,
  users,
} from "../db/schema/control-plane";
import { createLocalAccountIssuer } from "better-auth";
import { account } from "../db/schema/auth";
import { capabilitiesForRole } from "../membership-shared";
import { hashPassword, sha256Hex } from "../crypto";
import type { TestDb } from "../db/test-harness";
import type { Capability, Role } from "../types";

/**
 * `hashPassword` for SEEDED users, memoized per plaintext.
 *
 * The real thing is scrypt at the production work factor - deliberately, around
 * 180ms a call - and almost every test file seeds several users in a
 * `beforeEach`. Hashing "password1" afresh for each of them, in every test, in
 * every file, added minutes to the suite for no coverage at all.
 *
 * What is lost is a distinct salt per seeded row, which is a property of the
 * PRODUCTION path and is asserted where it belongs (lib/crypto.test.ts). What is
 * kept is the part any test could care about: a real hash of the real password,
 * produced by the real function, that `verifyPassword` accepts.
 */
const seedHashes = new Map<string, Promise<string>>();
function seedHash(password: string): Promise<string> {
  let p = seedHashes.get(password);
  if (!p) {
    p = hashPassword(password);
    seedHashes.set(password, p);
  }
  return p;
}

/**
 * Shared seeding for the identity cut-set (b) data-layer tests (relational-store
 * PLAN Step 3). Identity (`users`/`teams`/`memberships`(+capabilities) +
 * `registrationLinks`) is RELATIONAL: the authz backbone and `getCurrentUser`
 * read pglite. So this seeds the relational identity tables directly. The JSONB
 * store is gone (Step 6), so there is nothing else to reset.
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
  /**
   * The team's founder (absolute owner / "crown"). Defaults to the first seeded
   * `owner` user of the team — mirroring the backfill — so the existing
   * "owner is immutable" tests keep seeing USER_1 as TEAM_A's protected founder.
   */
  founderUserId?: string | null;
  /**
   * Whether this team allows AI agents over MCP. Defaults to TRUE here and
   * FALSE in production (migration 0106): a suite that exercises the MCP door
   * is not a suite about the kill switch, and every one of those tests would
   * otherwise open by turning the same switch on. The switch has its own
   * tests, which set it explicitly.
   */
  mcpEnabled?: boolean;
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
const DEFAULT_USERS: SeedUser[] = [
  { id: USER_1, teamId: TEAM_A, role: "owner" },
];

/**
 * Truncate every identity table (call in `beforeEach` before seeding).
 * `instance_settings` is listed explicitly rather than left to the `users`
 * cascade: the owner crown is identity state, and a row surviving into the next
 * test would silently arm (or disarm) the owner guards in `updateUserAdmin`.
 */
export const TRUNCATE_IDENTITY = `truncate table
  registration_links, membership_capabilities, memberships, users, teams,
  instance_settings
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

  // Users BEFORE teams: `teams.founder_user_id` FKs `users.id`, so the founder
  // must already exist when the team row is inserted (the production creators
  // insert the user first for the same reason).
  await db.insert(users).values(
    seedUsers.map((u) => {
      const role = u.role ?? "owner";
      return {
        id: u.id,
        email: u.email ?? `${u.id}@example.io`,
        username: u.id,
        name: u.id,
        role,
        isInstanceAdmin: u.isInstanceAdmin ?? role === "owner",
        suspended: u.suspended ?? false,
        avatarColor: "#abc",
        createdAt: T0,
        updatedAt: T0,
      };
    }),
  );
  // The credential lives on the Better Auth `account` row since migration 0055,
  // so a seeded user needs one too or every password re-check reads null.
  // Hashing is async (scrypt on the threadpool), so the rows are built first and
  // inserted after - `.map()` cannot await.
  await db.insert(account).values(
    await Promise.all(
      seedUsers.map(async (u) => ({
        id: `bacc_${u.id}`,
        userId: u.id,
        accountId: u.id,
        providerId: "credential",
        issuer: createLocalAccountIssuer("credential"),
        password: await seedHash(u.password ?? "password1"),
      })),
    ),
  );
  await db.insert(teams).values(
    seedTeams.map((t) => ({
      id: t.id,
      name: t.slug,
      slug: t.slug,
      plan: "pro" as const,
      mcpEnabled: t.mcpEnabled ?? true,
      // Explicit override, else the first seeded owner of the team (the backfill
      // rule); null when the team has no owner user seeded.
      founderUserId:
        t.founderUserId !== undefined
          ? t.founderUserId
          : (seedUsers.find(
              (u) => u.teamId === t.id && (u.role ?? "owner") === "owner",
            )?.id ?? null),
      createdAt: T0,
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
