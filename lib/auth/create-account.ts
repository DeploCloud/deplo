import "server-only";

import { eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, type DbTx } from "../db/client";
import {
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
} from "../db/schema/control-plane/access-control";
import {
  teams as teamsTable,
  users as usersTable,
} from "../db/schema/control-plane/identity";
import { instanceSettings as instanceSettingsTable } from "../db/schema/control-plane/instance";
import { monogramColor } from "../avatar-colors";
import type { Capability, Role, User } from "../types/identity";
import type { Team } from "../types/team";
import { capabilitiesForRole, cleanCapabilities } from "../membership-shared";
import {
  normalizeUsername,
  uniqueUsername,
  validateUsername,
} from "../username";
import {
  isValidTeamAvatarValue,
  isValidUserAvatarValue,
  randomFaceValue,
} from "../apps/avatar-shared";
import { randomBytes } from "node:crypto";
import { pickTeamSlug } from "../team-path";
import { assertPasswordPolicy } from "../password-policy";
import { assertPasswordNotPwned } from "../pwned-password";
import { insertCredentialAccount } from "./password-credential";

// Validate-free user insert shared by createAccountWithTeam and createAccountWithTeams.
async function insertUserCore(
  tx: DbTx,
  input: {
    username: string;
    name: string;
    email: string;
    password: string;
    image?: string | null;
  },
  opts: { isInstanceAdmin?: boolean; userRole?: string } = {},
): Promise<User> {
  const dup = await tx
    .select({ username: usersTable.username, email: usersTable.email })
    .from(usersTable)
    .where(
      or(
        eq(usersTable.username, input.username),
        eq(sql`lower(${usersTable.email})`, input.email),
      ),
    )
    .limit(1);
  if (dup[0]?.username === input.username)
    throw new Error("That username is taken");
  if (dup[0]) throw new Error("An account with this email already exists");

  // Derived from the name, exactly like a team's mark: the letters and the
  // colour then change together on a rename.
  const avatarColor = monogramColor(input.name);

  const now = new Date().toISOString();
  const user: User = {
    id: `usr_${randomBytes(8).toString("hex")}`,
    email: input.email,
    username: input.username,
    name: input.name,
    role: (opts.userRole ?? "member") as User["role"],
    avatarColor,
    createdAt: now,
    isInstanceAdmin: opts.isInstanceAdmin ?? false,
    suspended: false,
  };
  await tx.insert(usersTable).values({
    id: user.id,
    email: user.email,
    username: user.username,
    name: user.name,
    role: user.role,
    isInstanceAdmin: user.isInstanceAdmin ?? false,
    suspended: false,
    avatarColor: user.avatarColor,
    // Nobody picked one, so the account still gets a face rather than falling
    // back to its own letters: a name is not a picture.
    image: input.image ?? randomFaceValue(),
    createdAt: user.createdAt,
    updatedAt: now,
  });
  await insertCredentialAccount(tx, user.id, input.password);
  return user;
}

// createAccountWithTeam creates a brand-new account AND its own team in one transaction.
export async function createAccountWithTeam(
  input: {
    /** Omitted by first-run setup, which derives the handle from the name. */
    username?: string | null;
    name: string;
    email: string;
    password: string;
    teamName: string;
    image?: string | null;
    teamImage?: string | null;
  },
  opts: {
    guard?: (tx: DbTx) => Promise<void>;
    isInstanceAdmin?: boolean;
    isInstanceOwner?: boolean;
  } = {},
): Promise<{ user: User; team: Team }> {
  const username = input.username?.trim()
    ? normalizeUsername(input.username)
    : uniqueUsername(input.name, new Set());
  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(usernameError);

  const name = input.name.trim();
  if (!name) throw new Error("Name is required");

  const email = input.email.toLowerCase().trim();
  if (!email.includes("@")) throw new Error("Enter a valid email address");

  const teamName = input.teamName.trim();
  if (!teamName) throw new Error("Team name is required");
  // Straight off a form: the same gate `updateMyAvatar` applies.
  const image = input.image?.trim() || null;
  if (image && !isValidUserAvatarValue(image))
    throw new Error("Unsupported profile picture");
  const teamImage = input.teamImage?.trim() || null;
  if (teamImage && !isValidTeamAvatarValue(teamImage))
    throw new Error("Unsupported team picture");

  assertPasswordPolicy(input.password);
  await assertPasswordNotPwned(input.password);

  const now = new Date().toISOString();

  // The optional token consume + all uniqueness re-checks + the writes happen in ONE
  // db.transaction, so the whole critical section is atomic against concurrent
  // requests.
  const result = await getDb().transaction(async (tx) => {
    if (opts.guard) await opts.guard(tx); // e.g. consume the registration token

    const user = await insertUserCore(
      tx,
      { username, name, email, password: input.password, image },
      { isInstanceAdmin: opts.isInstanceAdmin, userRole: "owner" },
    );

    // The crown, claimed in the same transaction as the account it belongs to. This is
    // ALSO the atomic first-run guard.
    if (opts.isInstanceOwner) {
      const claimed = await tx
        .insert(instanceSettingsTable)
        .values({ id: "default", ownerUserId: user.id, updatedAt: now })
        .onConflictDoUpdate({
          target: instanceSettingsTable.id,
          set: { ownerUserId: user.id, updatedAt: now },
          setWhere: isNull(instanceSettingsTable.ownerUserId),
        })
        .returning({ id: instanceSettingsTable.id });
      if (claimed.length === 0)
        throw new Error("Setup has already been completed");
    }

    // Team name uniqueness + slug dedupe against live rows.
    const teamDup = await tx
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(eq(sql`lower(${teamsTable.name})`, teamName.toLowerCase()))
      .limit(1);
    if (teamDup[0]) throw new Error("That team name is taken");
    const finalSlug = pickTeamSlug(
      teamName,
      (await tx.select({ slug: teamsTable.slug }).from(teamsTable)).map(
        (r) => r.slug,
      ),
    );

    const team: Team = {
      id: `team_${randomBytes(8).toString("hex")}`,
      name: teamName,
      slug: finalSlug,
      plan: "pro",
      // The registrant is the founder (absolute owner / "crown") of their team.
      founderUserId: user.id,
      avatarUrl: teamImage,
      createdAt: now,
    };
    const membershipId = `mbr_${randomBytes(8).toString("hex")}`;
    const ownerCaps = capabilitiesForRole("owner");

    // FK-safe inserts: team → membership → membership_capabilities (the user row
    // was already inserted by insertUserCore above, so the founder FK resolves).
    await tx.insert(teamsTable).values({
      id: team.id,
      name: team.name,
      slug: team.slug,
      plan: team.plan,
      founderUserId: team.founderUserId,
      image: teamImage,
      createdAt: team.createdAt,
    });
    await tx.insert(membershipsTable).values({
      id: membershipId,
      userId: user.id,
      teamId: team.id,
      role: "owner",
      createdAt: now,
    });
    await tx
      .insert(membershipCapabilitiesTable)
      .values(ownerCaps.map((c) => ({ membershipId, capability: c })));

    return { user, team };
  });
  return result;
}

// createAccountWithTeams creates a brand-new account that JOINS existing teams as a
// member (it owns none), with the per-team role + capabilities baked into the link.
export async function createAccountWithTeams(
  input: {
    username: string;
    name: string;
    email: string;
    password: string;
    image?: string | null;
  },
  assignments: { teamId: string; role: Role; capabilities: Capability[] }[],
  opts: { guard?: (tx: DbTx) => Promise<void> } = {},
): Promise<{ user: User; activeTeamId: string }> {
  const username = normalizeUsername(input.username);
  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(usernameError);
  const name = input.name.trim();
  if (!name) throw new Error("Name is required");
  const email = input.email.toLowerCase().trim();
  if (!email.includes("@")) throw new Error("Enter a valid email address");
  const image = input.image?.trim() || null;
  if (image && !isValidUserAvatarValue(image))
    throw new Error("Unsupported profile picture");
  assertPasswordPolicy(input.password);
  await assertPasswordNotPwned(input.password);
  if (assignments.length === 0)
    throw new Error("This registration link has no teams to join");

  return getDb().transaction(async (tx) => {
    if (opts.guard) await opts.guard(tx); // consume the registration token atomically

    // Re-resolve assignments against teams that still exist (one may have been
    // deleted since the link was minted). Drop the missing; fail if none remain.
    const live = await tx
      .select({ id: teamsTable.id })
      .from(teamsTable)
      .where(
        inArray(
          teamsTable.id,
          assignments.map((a) => a.teamId),
        ),
      );
    const liveIds = new Set(live.map((r) => r.id));
    const resolved = assignments.filter((a) => liveIds.has(a.teamId));
    if (resolved.length === 0)
      throw new Error("The teams for this registration link no longer exist");

    const user = await insertUserCore(
      tx,
      { username, name, email, password: input.password, image },
      { isInstanceAdmin: false, userRole: "member" },
    );

    const now = new Date().toISOString();
    for (const a of resolved) {
      const membershipId = `mbr_${randomBytes(8).toString("hex")}`;
      const caps = cleanCapabilities(a.capabilities, a.role);
      await tx.insert(membershipsTable).values({
        id: membershipId,
        userId: user.id,
        teamId: a.teamId,
        role: a.role,
        createdAt: now,
      });
      await tx
        .insert(membershipCapabilitiesTable)
        .values(caps.map((c) => ({ membershipId, capability: c })));
    }
    return { user, activeTeamId: resolved[0].teamId };
  });
}
