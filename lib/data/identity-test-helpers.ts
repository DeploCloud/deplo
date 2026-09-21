import {
  memberships,
  membershipCapabilities,
} from "../db/schema/control-plane/access-control";
import {
  registrationLinks,
  teams,
  users,
} from "../db/schema/control-plane/identity";
import { account } from "../db/schema/auth";
import { capabilitiesForRole } from "../membership-shared";
import { hashPassword, sha256Hex } from "../crypto";
import type { TestDb } from "../db/test-harness";
import type { Capability, Role } from "../types/identity";

const seedHashes = new Map<string, Promise<string>>();
function seedHash(password: string): Promise<string> {
  let p = seedHashes.get(password);
  if (!p) {
    p = hashPassword(password);
    seedHashes.set(password, p);
  }
  return p;
}

export const TEAM_A = "team_a";
export const TEAM_B = "team_b";
export const USER_1 = "user_1";

const T0 = "2026-01-01T00:00:00.000Z";

export interface SeedTeam {
  id: string;
  slug: string;
  founderUserId?: string | null;
  mcpEnabled?: boolean;
}
export interface SeedUser {
  id: string;
  teamId: string;
  role?: Role;
  capabilities?: Capability[];
  isInstanceAdmin?: boolean;
  suspended?: boolean;
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

export const TRUNCATE_IDENTITY = `truncate table
  registration_links, membership_capabilities, memberships, users, teams,
  instance_settings
  restart identity cascade;`;

export async function seedIdentity(
  db: TestDb,
  opts: { teams?: SeedTeam[]; users?: SeedUser[] } = {},
): Promise<void> {
  const seedTeams = opts.teams ?? DEFAULT_TEAMS;
  const seedUsers = opts.users ?? DEFAULT_USERS;

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
  await db.insert(account).values(
    await Promise.all(
      seedUsers.map(async (u) => ({
        id: `bacc_${u.id}`,
        userId: u.id,
        accountId: u.id,
        providerId: "credential",
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
    expiresAt: opts.expiresAt ?? "2099-01-01T00:00:00.000Z",
    createdAt: T0,
    usedAt: null,
  });
  return rawToken;
}
