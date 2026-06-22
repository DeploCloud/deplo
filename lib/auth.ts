import "server-only";

import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { read, mutate, ensureStoreReady } from "./store";
import {
  hashPassword,
  verifyPassword,
  signSession,
  verifySession,
} from "./crypto";
import type {
  DeploData,
  Membership,
  PublicUser,
  Role,
  Team,
  User,
} from "./types";
import { capabilitiesForRole } from "./membership-shared";
import { normalizeUsername, validateUsername, uniqueUsername } from "./username";
import { randomBytes } from "node:crypto";
import { currentIdentity } from "./auth/request-context";

const SESSION_COOKIE = "deplo_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
// Kept in sync with lib/membership.ts (ACTIVE_TEAM_COOKIE). Set here on
// signup/setup so the new account lands with an active team immediately,
// avoiding a circular import with the membership module.
const ACTIVE_TEAM_COOKIE = "deplo_team";
const ACTIVE_TEAM_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year

async function setActiveTeamCookie(teamId: string) {
  const store = await cookies();
  const secure = (process.env.DEPLO_PUBLIC_URL ?? "").startsWith("https://");
  store.set(ACTIVE_TEAM_COOKIE, teamId, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: ACTIVE_TEAM_TTL_SECONDS,
  });
}

function toPublic(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    name: u.name,
    role: u.role,
    isInstanceAdmin: u.isInstanceAdmin ?? false,
    avatarColor: u.avatarColor,
  };
}

const AVATAR_COLORS = ["#50e3c2", "#f5a623", "#7928ca", "#ff0080", "#0070f3"];

/** True if a username is already in use (case-insensitive, normalized). */
export function isUsernameTaken(username: string): boolean {
  const n = normalizeUsername(username);
  return read().users.some((u) => u.username === n);
}

/**
 * Create a brand-new account AND its own team in one mutation, returning the
 * new user + team. Shared by first-run setup and the register link (public
 * signup was removed — accounts after the first require an invite). The
 * registrant is the OWNER of their team. Validates the username +
 * team name and enforces global uniqueness of both. Does NOT set cookies — the
 * caller signs the user in (so this stays usable from non-request contexts).
 *
 * `opts.guard` runs INSIDE the same atomic mutate() that persists the new
 * account, BEFORE anything is pushed. The register-link flow uses it to consume
 * the single-use token atomically with creation — if it throws, nothing is
 * persisted, closing the check-create-consume TOCTOU where a concurrent
 * double-submit could mint two accounts from one link. `opts.isInstanceAdmin`
 * marks the account a global admin (the very first account, or an admin-minted
 * one if you choose).
 */
export function createAccountWithTeam(
  input: {
    username: string;
    name: string;
    email: string;
    password: string;
    teamName: string;
  },
  opts: { guard?: (data: DeploData) => void; isInstanceAdmin?: boolean } = {},
): { user: User; team: Team } {
  const username = normalizeUsername(input.username);
  const usernameError = validateUsername(username);
  if (usernameError) throw new Error(usernameError);

  const name = input.name.trim();
  if (!name) throw new Error("Name is required");

  const email = input.email.toLowerCase().trim();
  if (!email.includes("@")) throw new Error("Enter a valid email address");

  const teamName = input.teamName.trim();
  if (!teamName) throw new Error("Team name is required");
  const slug =
    teamName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "team";

  if (input.password.length < 8)
    throw new Error("Choose a password of at least 8 characters");

  const now = new Date().toISOString();
  const d = read();
  const team: Team = {
    id: `team_${randomBytes(8).toString("hex")}`,
    name: teamName,
    slug, // finalised inside mutate against the live draft
    plan: "pro",
    createdAt: now,
  };
  const user: User = {
    id: `usr_${randomBytes(8).toString("hex")}`,
    email,
    username,
    name,
    passwordHash: hashPassword(input.password),
    role: "owner",
    avatarColor: AVATAR_COLORS[d.users.length % AVATAR_COLORS.length],
    createdAt: now,
    isInstanceAdmin: opts.isInstanceAdmin ?? false,
    suspended: false,
  };
  const ownerMembership: Membership = {
    id: `mbr_${randomBytes(8).toString("hex")}`,
    userId: user.id,
    teamId: team.id,
    role: "owner",
    capabilities: capabilitiesForRole("owner"),
    createdAt: now,
  };
  // All uniqueness checks + the optional token consume + the writes happen in
  // ONE synchronous mutate() with no await inside, so the whole critical
  // section is atomic against concurrent requests.
  mutate((data) => {
    if (opts.guard) opts.guard(data); // e.g. consume the registration token
    if (data.users.some((u) => u.username === username))
      throw new Error("That username is taken");
    if (data.users.some((u) => u.email.toLowerCase() === email))
      throw new Error("An account with this email already exists");
    if (data.teams.some((t) => t.name.toLowerCase() === teamName.toLowerCase()))
      throw new Error("That team name is taken");
    const takenSlugs = new Set(data.teams.map((t) => t.slug));
    let finalSlug = slug;
    for (let i = 2; takenSlugs.has(finalSlug); i++) finalSlug = `${slug}-${i}`;
    team.slug = finalSlug;
    data.teams.push(team);
    data.users.push(user);
    data.memberships.push(ownerMembership);
  });
  return { user, team };
}

/**
 * Resolve the current user from the signed session cookie.
 * Cached per-request so it can be called from many places cheaply.
 * Returns null when unauthenticated. Never throws.
 */
export const getCurrentUser = cache(async (): Promise<PublicUser | null> => {
  await ensureStoreReady();
  // A bearer-token request (the public GraphQL API) supplies its principal via
  // the request-context override and carries no session cookie.
  const override = currentIdentity();
  const uid = override
    ? override.userId
    : verifySession((await cookies()).get(SESSION_COOKIE)?.value)?.uid;
  if (!uid) return null;
  const user = read().users.find((u) => u.id === uid);
  // A suspended account loses access immediately, even with a live session.
  if (!user || user.suspended) return null;
  return toPublic(user);
});

/**
 * Require an authenticated user. Redirects to the setup wizard on a fresh
 * install (no users yet), otherwise to /login.
 */
export async function requireUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) redirect((await isSetupNeeded()) ? "/setup" : "/login");
  return user;
}

/** True on a fresh install with no account yet  the setup wizard is required. */
export async function isSetupNeeded(): Promise<boolean> {
  await ensureStoreReady();
  return read().users.length === 0;
}

/** Throwing variant for server actions / route handlers. */
export async function assertUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

async function setSessionCookie(userId: string) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = signSession({ uid: userId, exp });
  const store = await cookies();
  // Secure must track the *actual* scheme, not NODE_ENV: a production instance
  // served over http://<ip> (no domain/TLS yet) would otherwise drop the cookie.
  const secure = (process.env.DEPLO_PUBLIC_URL ?? "").startsWith("https://");
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export async function login(
  email: string,
  password: string
): Promise<{ ok: boolean; error?: string }> {
  await ensureStoreReady();
  const user = read().users.find(
    (u) => u.email.toLowerCase() === email.toLowerCase().trim()
  );
  // Always run a hash comparison to reduce user-enumeration timing signal.
  const stored =
    user?.passwordHash ??
    "scrypt$00000000000000000000000000000000$00000000000000000000000000000000";
  const valid = verifyPassword(password, stored);
  if (!user || !valid) return { ok: false, error: "Invalid email or password" };
  if (user.suspended)
    return { ok: false, error: "This account has been suspended" };
  await setSessionCookie(user.id);
  return { ok: true };
}

/**
 * First-run setup: create the workspace (team) and the owner account, then sign
 * the owner in. Refuses to run once any account exists. NO server is seeded — the
 * operator adds the host running Deplo (and any others) through the normal "Add
 * server" flow and runs the install command on each box, so every server is a
 * bootstrapped, pinned agent uniformly (the host running Deplo included).
 */
export async function completeSetup(input: {
  username: string;
  teamName: string;
  name: string;
  email: string;
  password: string;
}): Promise<{ ok: boolean; error?: string }> {
  await ensureStoreReady();
  if (read().users.length > 0)
    return { ok: false, error: "Setup has already been completed" };

  let user: User;
  let team: Team;
  try {
    // First account + its team, with all the username/team-name validation.
    // The very first account is the instance admin.
    ({ user, team } = createAccountWithTeam(
      {
        username: input.username,
        name: input.name,
        email: input.email,
        password: input.password,
        teamName: input.teamName.trim() || "Workspace",
      },
      { isInstanceAdmin: true },
    ));
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Setup failed" };
  }

  await setSessionCookie(user.id);
  await setActiveTeamCookie(team.id);
  return { ok: true };
}

/**
 * Sign a user in by id and make a team active. Used by the invite-accept flow,
 * which creates the user/membership in the data layer and then logs them in.
 */
export async function startSessionFor(
  userId: string,
  teamId: string,
): Promise<void> {
  await setSessionCookie(userId);
  await setActiveTeamCookie(teamId);
}

/**
 * Switch the active-team cookie for the already-signed-in user. Used when an
 * existing, logged-in user accepts an invite (the membership was just created
 * in the same request, so we write the cookie directly rather than round-trip
 * the membership validation, which may read a stale per-request cache).
 */
export async function setActiveTeamForCurrentUser(teamId: string): Promise<void> {
  await setActiveTeamCookie(teamId);
}

export async function logout() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
  store.delete(ACTIVE_TEAM_COOKIE);
}

export { SESSION_COOKIE };
