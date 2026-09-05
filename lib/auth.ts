import "server-only";

import { cache } from "@/lib/request-cache";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { and, count, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDb, type DbTx } from "./db/client";
import {
  instanceSettings as instanceSettingsTable,
  memberships as membershipsTable,
  membershipCapabilities as membershipCapabilitiesTable,
  teams as teamsTable,
  users as usersTable,
} from "./db/schema/control-plane";
import {
  account as accountTable,
  session as sessionTable,
} from "./db/schema/auth";
import { createLocalAccountIssuer } from "better-auth";
import {
  constantTimeEquals,
  hashPassword,
  passwordNeedsRehash,
  verifyPassword,
} from "./crypto";
import { avatarUrlFor } from "./avatar";
import { monogramColor } from "./avatar-colors";
import type { Capability, PublicUser, Role, Team, User } from "./types";
import { capabilitiesForRole, cleanCapabilities } from "./membership-shared";
import {
  normalizeUsername,
  uniqueUsername,
  validateUsername,
} from "./username";
import {
  isValidTeamAvatarValue,
  isValidUserAvatarValue,
} from "./apps/avatar-shared";
import { newId } from "./ids";
import { randomBytes } from "node:crypto";
import { currentIdentity } from "./auth/request-context";
import { authRequestHeaders } from "./auth/request-headers";
import {
  ACTIVE_TEAM_COOKIE,
  ACTIVE_TEAM_TTL_SECONDS,
  pickTeamSlug,
} from "./team-path";
import {
  getAuth,
  requireAuth,
  sessionCookieNames,
  SECURE_COOKIE_PREFIX,
  SESSION_TTL_SECONDS,
} from "./auth/better-auth";
import {
  cookiesAreSecure,
  passkeyRelyingParty,
  requestIsHttps,
} from "./public-url";
// Type-only: the assertion arrives as opaque JSON from the browser, and this is
// the shape the plugin's verifier expects it to have.
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import { assertPasswordPolicy } from "./password-policy";
import { assertPasswordNotPwned } from "./pwned-password";

/**
 * WHICH authority vouched for a password account - `account.issuer`, required
 * since Better Auth 1.7.0, which keys an account on `(issuer, accountId)`.
 */
const CREDENTIAL_ISSUER = createLocalAccountIssuer("credential");

/** Signup/setup only: land the new account with an active team, without the
 * circular import that calling `setActiveTeam` from here would need. */
async function setActiveTeamCookie(teamId: string) {
  const store = await cookies();
  store.set(ACTIVE_TEAM_COOKIE, teamId, {
    httpOnly: true,
    // Per REQUEST, not per instance: on the panel's own IP address, which is
    // plain http, a `Secure` cookie is one the browser drops - and this one
    // carries the active team.
    secure: await requestIsHttps(),
    sameSite: "lax",
    path: "/",
    maxAge: ACTIVE_TEAM_TTL_SECONDS,
  });
}

/** Columns projected for a {@link PublicUser}, never a credential. */
const PUBLIC_USER_COLS = {
  id: usersTable.id,
  email: usersTable.email,
  username: usersTable.username,
  name: usersTable.name,
  role: usersTable.role,
  isInstanceAdmin: usersTable.isInstanceAdmin,
  avatarColor: usersTable.avatarColor,
  image: usersTable.image,
  twoFactorEnabled: usersTable.twoFactorEnabled,
} as const;

/**
 * Async only because of `avatarUrl`: resolving it reads the instance's Gravatar
 * flag. One caller ({@link getCurrentUser}), already async.
 */
async function toPublic(u: {
  id: string;
  email: string;
  username: string;
  name: string;
  role: string;
  isInstanceAdmin: boolean | null;
  avatarColor: string;
  image: string | null;
  twoFactorEnabled: boolean | null;
}): Promise<PublicUser> {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    name: u.name,
    role: u.role as PublicUser["role"],
    isInstanceAdmin: u.isInstanceAdmin ?? false,
    avatarColor: u.avatarColor,
    avatarUrl: await avatarUrlFor(u),
    twoFactorEnabled: u.twoFactorEnabled ?? false,
  };
}

/** True if a username is already in use (case-insensitive, normalized). */
export async function isUsernameTaken(username: string): Promise<boolean> {
  const n = normalizeUsername(username);
  const rows = await getDb()
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, n))
    .limit(1);
  return rows.length > 0;
}

/**
 * Validate-free user insert shared by {@link createAccountWithTeam} and {@link
 * createAccountWithTeams}.
 */
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
    image: input.image ?? null,
    createdAt: user.createdAt,
    updatedAt: now,
  });
  // `account_id` is the provider's own subject id; for `credential` that is the
  // user id, matching the 0055 backfill.
  await tx.insert(accountTable).values({
    id: newId("bacc"),
    userId: user.id,
    accountId: user.id,
    providerId: "credential",
    issuer: CREDENTIAL_ISSUER,
    password: await hashPassword(input.password),
  });
  return user;
}

/**
 * Create a brand-new account AND its own team in one transaction, returning the
 * new user + team. Shared by first-run setup and the register link (public signup
 * was removed - accounts after the first require an invite).
 */
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
  // Team ordering (project/folder) is now the `team_app_order` / `team_folder_order`
  // junctions (cut-set c) - a brand-new team simply has no order rows yet and
  // `listApps`/`listFolders` fall back to newest-first.
  return result;
}

/**
 * Create a brand-new account that JOINS one or more EXISTING teams as a member (it
 * owns none). `assignments` is the validated per-team role + capabilities baked
 * into the link.
 */
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

/**
 * The headers for a Better Auth server call: this request's session metadata (user
 * agent + IP chain) plus its current cookies.
 */
export async function authHeaders(): Promise<Headers> {
  let request: Headers | null = null;
  try {
    request = await headers();
  } catch {
    /* no request scope */
  }
  let cookie = "";
  try {
    const store = await cookies();
    cookie = store
      .getAll()
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  } catch {
    /* no request scope */
  }
  return authRequestHeaders(request, cookie);
}

/**
 * Re-issue the cookies Better Auth just wrote, without `Secure`, when this request
 * did not arrive over https.
 */
async function keepAuthCookiesUsableOverHttp(): Promise<void> {
  if (!cookiesAreSecure()) return;
  if (await requestIsHttps()) return;
  const secureSessionCookie = sessionCookieNames()[1];
  const store = await cookies();
  for (const c of store.getAll()) {
    if (!c.name.startsWith(SECURE_COOKIE_PREFIX)) continue;
    store.set(c.name.slice(SECURE_COOKIE_PREFIX.length), c.value, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
      ...(c.name === secureSessionCookie
        ? { maxAge: SESSION_TTL_SECONDS }
        : {}),
    });
    store.delete(c.name);
  }
}

/**
 * This request's Better Auth session, resolved AT MOST ONCE.
 */
const currentSession = cache(async () => {
  if (currentIdentity()) return null;
  const auth = getAuth();
  if (!auth) return null;
  return auth.api
    .getSession({ headers: await authHeaders() })
    .catch(() => null);
});

/**
 * Resolve the current user from the Better Auth session (ADR-0014).
 */
export const getCurrentUser = cache(async (): Promise<PublicUser | null> => {
  // A bearer-token request (the public GraphQL API) supplies its principal via
  // the request-context override and carries no session cookie.
  const override = currentIdentity();
  let uid = override?.userId;
  if (!uid) uid = (await currentSession())?.user?.id;
  if (!uid) return null;
  const rows = await getDb()
    .select({ ...PUBLIC_USER_COLS, suspended: usersTable.suspended })
    .from(usersTable)
    .where(eq(usersTable.id, uid))
    .limit(1);
  const user = rows[0];
  // A suspended account loses access immediately, even with a live session.
  if (!user || user.suspended) return null;
  return toPublic(user);
});

/**
 * The id of the session row this request is authenticated by, or null.
 */
export const currentSessionId = cache(async (): Promise<string | null> => {
  // An identity that names its session wins: see `RequestIdentity.sessionId`.
  // A bearer token never names one, so it still falls through to null.
  return (
    currentIdentity()?.sessionId ??
    (await currentSession())?.session?.id ??
    null
  );
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
  const n = (await getDb().select({ n: count() }).from(usersTable))[0]!.n;
  return n === 0;
}

export type SetupKeyState = "ok" | "missing" | "wrong";

/**
 * The installer mints `DEPLO_SETUP_KEY` and prints it in the setup link, so the
 * first account is claimed by whoever ran the install rather than by whoever
 * reaches the panel first. No key configured leaves setup exactly as it was.
 */
export function checkSetupKey(
  presented: string | null | undefined,
): SetupKeyState {
  const expected = process.env.DEPLO_SETUP_KEY?.trim();
  if (!expected) return "ok";
  if (!presented) return "missing";
  return constantTimeEquals(presented, expected) ? "ok" : "wrong";
}

/** Throwing variant for server actions / route handlers. */
export async function assertUser(): Promise<PublicUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

/**
 * Verify a user's OWN password - the re-auth step in front of every sensitive
 * account action (change email / change password / transfer ownership / enable or
 * disable 2FA).
 */
export async function verifyUserPassword(
  userId: string,
  password: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ password: accountTable.password })
    .from(accountTable)
    .where(
      and(
        eq(accountTable.userId, userId),
        eq(accountTable.providerId, "credential"),
      ),
    )
    .limit(1);
  const stored = rows[0]?.password;
  if (!stored) return false;
  return await verifyPassword(password, stored);
}

/** Replace a user's stored credential. Used by admin reset + the recover script. */
export async function setUserPassword(
  userId: string,
  password: string,
  tx?: DbTx,
): Promise<void> {
  const db = tx ?? getDb();
  const updated = await db
    .update(accountTable)
    .set({ password: await hashPassword(password), updatedAt: new Date() })
    .where(
      and(
        eq(accountTable.userId, userId),
        eq(accountTable.providerId, "credential"),
      ),
    )
    .returning({ id: accountTable.id });
  // An account created before it had a credential row (or one whose provider row
  // was deleted) still needs a password to be settable.
  if (updated.length === 0)
    await db.insert(accountTable).values({
      id: newId("bacc"),
      userId,
      accountId: userId,
      providerId: "credential",
      issuer: CREDENTIAL_ISSUER,
      password: await hashPassword(password),
    });
}

/**
 * Delete every Better Auth session row for a user - the replacement for the old
 * `token_version` bump.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  const auth = getAuth();
  if (!auth) return;
  const ctx = await auth.$context;
  await ctx.internalAdapter.deleteUserSessions(userId);
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  /** The account has 2FA: no session was created, a TOTP code is still required. */
  requiresTwoFactor?: boolean;
}

/**
 * Sign in with email + password (Better Auth, ADR-0014). The caller must then send
 * a code to `verifyTwoFactorCode`.
 */
export async function login(
  email: string,
  password: string,
): Promise<LoginResult> {
  const normalized = email.toLowerCase().trim();
  try {
    const res = await requireAuth().api.signInEmail({
      body: { email: normalized, password },
      headers: await authHeaders(),
      asResponse: false,
    });
    // Before the two-factor branch below: by this point Better Auth has written
    // either the session cookie or the challenge cookie, and on the IP
    // address both need declassifying for the browser to keep them.
    await keepAuthCookiesUsableOverHttp();
    // Suspension is enforced only NOW, after the password verified, so "this account
    // has been suspended" is revealed only to someone who proved the credential, never
    // as a pre-auth existence oracle.
    const account = (
      await getDb()
        .select({ id: usersTable.id, suspended: usersTable.suspended })
        .from(usersTable)
        .where(eq(sql`lower(${usersTable.email})`, normalized))
        .limit(1)
    )[0];
    if (account?.suspended) {
      await revokeAllSessions(account.id).catch(() => {});
      return { ok: false, error: "This account has been suspended" };
    }
    // The credential was just proven, so this is the one moment the plaintext and the
    // identity are both in hand - the only place a hash written at an older, weaker
    // cost can be replaced without asking anyone to reset anything.
    void upgradePasswordHash(normalized, password);
    if (res && "twoFactorRedirect" in res && res.twoFactorRedirect)
      return { ok: false, requiresTwoFactor: true };
    return { ok: true };
  } catch (e) {
    // ONLY a genuine credential rejection becomes "Invalid email or password".
    if (isCredentialRejection(e))
      return { ok: false, error: "Invalid email or password" };
    throw e;
  }
}

/**
 * Re-hash a just-proven password when the stored one was made with a weaker
 * setting than {@link hashPassword} now uses. What it must never do is make a
 * correct password look wrong.
 */
async function upgradePasswordHash(
  normalizedEmail: string,
  password: string,
): Promise<void> {
  try {
    const rows = await getDb()
      .select({ id: accountTable.id, password: accountTable.password })
      .from(accountTable)
      .innerJoin(usersTable, eq(usersTable.id, accountTable.userId))
      .where(
        and(
          eq(sql`lower(${usersTable.email})`, normalizedEmail),
          eq(accountTable.providerId, "credential"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.password || !passwordNeedsRehash(row.password)) return;
    const fresh = await hashPassword(password);
    await getDb()
      .update(accountTable)
      // The old hash is part of the WHERE: between the read above and this write the user
      // may have changed their password in another tab, and overwriting THAT with a
      // re-hash of the old one would silently restore a credential they had just
      .set({ password: fresh, updatedAt: new Date() })
      .where(
        and(
          eq(accountTable.id, row.id),
          eq(accountTable.password, row.password),
        ),
      );
  } catch {
    // Deliberately swallowed - see the docblock.
  }
}

/** Better Auth's own codes for "those credentials are wrong", and nothing else. */
function isCredentialRejection(e: unknown): boolean {
  const code = (e as { body?: { code?: string } } | null)?.body?.code;
  return (
    code === "INVALID_EMAIL_OR_PASSWORD" ||
    code === "USER_NOT_FOUND" ||
    code === "INVALID_PASSWORD" ||
    code === "CREDENTIAL_ACCOUNT_NOT_FOUND"
  );
}

/**
 * Finish a login that stopped at `requiresTwoFactor`, with a TOTP code or one of
 * the account's single-use backup codes.
 */
export async function verifyTwoFactorCode(
  code: string,
  kind: "totp" | "backup",
): Promise<{ ok: boolean; error?: string }> {
  const auth = requireAuth();
  // Not named `headers`: that shadows the `next/headers` import in this module.
  const reqHeaders = await authHeaders();
  try {
    if (kind === "backup")
      await auth.api.verifyBackupCode({ body: { code }, headers: reqHeaders });
    else await auth.api.verifyTOTP({ body: { code }, headers: reqHeaders });
    await keepAuthCookiesUsableOverHttp();
    return { ok: true };
  } catch (e) {
    // The plugin's own message is the useful one ("Invalid code", or the lockout
    // notice after too many failures), so surface it rather than a generic.
    const message = e instanceof Error ? e.message : "";
    return { ok: false, error: message || "That code is not valid" };
  }
}

/**
 * The options the browser hands to `navigator.credentials.get` to sign in.
 */
export async function passkeyChallenge(): Promise<unknown> {
  // Refused up front on an instance that cannot have passkeys at all.
  if (!passkeyRelyingParty())
    throw new Error(
      "Passkeys need this panel to be reachable at its own https address.",
    );
  return requireAuth().api.generatePasskeyAuthenticationOptions({
    headers: await authHeaders(),
  });
}

/**
 * Mark a session as opened by a WebAuthn ceremony.
 */
export async function markSessionAuthMethod(
  sessionId: string,
  userId: string,
  method: "passkey",
): Promise<void> {
  try {
    await getDb()
      .update(sessionTable)
      .set({ authMethod: method })
      .where(
        and(eq(sessionTable.id, sessionId), eq(sessionTable.userId, userId)),
      );
  } catch {
    /* see the docblock */
  }
}

/**
 * The newest session on an account, for the one caller that has just revoked every
 * other one and needs to find the replacement it minted. Anywhere else, an account
 * has several sessions and this would be a guess.
 */
export async function replacementSessionIdFor(
  userId: string,
): Promise<string | null> {
  const rows = await getDb()
    .select({ id: sessionTable.id })
    .from(sessionTable)
    .where(eq(sessionTable.userId, userId))
    .orderBy(desc(sessionTable.createdAt))
    .limit(1);
  return rows[0]?.id ?? null;
}

/**
 * How the CURRENT request's session proved itself, or null when the question does
 * not apply. Request-cached: the mandate gate asks on every capability check.
 */
export const currentSessionAuthMethod = cache(
  async (): Promise<string | null> => {
    const id = await currentSessionId();
    if (!id) return null;
    const rows = await getDb()
      .select({ method: sessionTable.authMethod })
      .from(sessionTable)
      .where(eq(sessionTable.id, id))
      .limit(1);
    return rows[0]?.method ?? null;
  },
);

/**
 * Finish a passkey sign-in with what the authenticator produced.
 */
export async function verifyPasskeyLogin(
  response: unknown,
): Promise<LoginResult> {
  let userId: string;
  try {
    const res = await requireAuth().api.verifyPasskeyAuthentication({
      body: { response: response as AuthenticationResponseJSON },
      headers: await authHeaders(),
    });
    userId = res.user.id;
    // The session exists and its cookie is written; this is what says HOW.
    await markSessionAuthMethod(res.session.id, res.user.id, "passkey");
  } catch (e) {
    // The plugin's own copy is the useful one here ("Passkey not found",
    // "Authentication failed", or the user-verification refusal Deplo adds) - but ONLY
    // its copy.
    const fromAuth = Boolean(
      (e as { body?: { code?: string } } | null)?.body?.code,
    );
    const message = fromAuth && e instanceof Error ? e.message : "";
    return { ok: false, error: message || "That passkey did not work" };
  }
  const rows = await getDb()
    .select({ suspended: usersTable.suspended })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (rows[0]?.suspended) {
    await logout();
    return { ok: false, error: "This account has been suspended" };
  }
  return { ok: true };
}

/**
 * First-run setup: create the workspace (team) and the owner account, then sign
 * the owner in.
 */
export async function completeSetup(input: {
  username?: string | null;
  teamName: string;
  name: string;
  email: string;
  password: string;
  image?: string | null;
  teamImage?: string | null;
  /** From the installer's setup link. Checked before anything touches the db. */
  key?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  if (checkSetupKey(input.key) !== "ok")
    return { ok: false, error: "That setup link is not valid." };

  const existing = (await getDb().select({ n: count() }).from(usersTable))[0]!
    .n;
  if (existing > 0)
    return { ok: false, error: "Setup has already been completed" };

  let user: User;
  let team: Team;
  try {
    // First account + its team, with all the username/team-name validation.
    ({ user, team } = await createAccountWithTeam(
      {
        username: input.username,
        name: input.name,
        email: input.email,
        password: input.password,
        teamName: input.teamName.trim() || "Workspace",
        image: input.image,
        teamImage: input.teamImage,
      },
      { isInstanceAdmin: true, isInstanceOwner: true },
    ));
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Setup failed",
    };
  }

  await startSessionFor(user.email, input.password, team.id);
  return { ok: true };
}

/**
 * Sign a freshly created account in and make a team active - the tail of setup and
 * of the registration-link flow. A brand-new account can never have 2FA, so there
 * is no challenge branch to handle here.
 */
export async function startSessionFor(
  email: string,
  password: string,
  teamId?: string,
): Promise<void> {
  await requireAuth().api.signInEmail({
    // Normalized the same way the account was stored, so a registrant who typed
    // a capitalised address still matches their own brand-new row.
    body: { email: email.toLowerCase().trim(), password },
    headers: await authHeaders(),
    asResponse: false,
  });
  await keepAuthCookiesUsableOverHttp();
  // Omitted when the caller is only re-issuing a session (e.g. after a password
  // change), where the existing `deplo_team` cookie must survive untouched.
  if (teamId) await setActiveTeamCookie(teamId);
}

/**
 * Switch the active-team cookie for the already-signed-in user.
 */
export async function setActiveTeamForCurrentUser(
  teamId: string,
): Promise<void> {
  await setActiveTeamCookie(teamId);
}

/**
 * Sign out: delete the session ROW (so the token is dead everywhere, not merely
 * forgotten by this browser) and clear both cookies. Best-effort on the Better
 * Auth side - a failed revoke must still let the browser drop its cookies.
 */
export async function logout() {
  const auth = getAuth();
  if (auth)
    await auth.api
      .signOut({ headers: await authHeaders() })
      .catch(() => undefined);
  const store = await cookies();
  for (const name of sessionCookieNames()) store.delete(name);
  store.delete(ACTIVE_TEAM_COOKIE);
}
