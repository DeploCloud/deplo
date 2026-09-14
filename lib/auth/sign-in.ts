import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { cookies } from "next/headers";
import { getDb } from "../db/client";
import { account as accountTable } from "../db/schema/auth";
import { users as usersTable } from "../db/schema/control-plane/identity";
import { hashPassword, passwordNeedsRehash } from "../crypto";
import { getAuth, requireAuth, sessionCookieNames } from "./better-auth";
import {
  authHeaders,
  keepAuthCookiesUsableOverHttp,
  setActiveTeamCookie,
} from "./session-cookies";
import { markSessionAuthMethod, revokeAllSessions } from "./session-records";
import { passkeyRelyingParty } from "../public-url";
import { ACTIVE_TEAM_COOKIE } from "../team-path";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";

export interface LoginResult {
  ok: boolean;
  error?: string;
  /** The account has 2FA: no session was created, a TOTP code is still required. */
  requiresTwoFactor?: boolean;
}

// emailForIdentifier resolves a sign-in identifier. A username nobody has falls through
// unchanged, so a wrong one is refused by the credential check like any other - never by
// a different answer, which would make this an account-existence oracle.
export async function emailForIdentifier(identifier: string): Promise<string> {
  const value = identifier.toLowerCase().trim();
  if (!value || value.includes("@")) return value;
  return (
    (
      await getDb()
        .select({ email: usersTable.email })
        .from(usersTable)
        .where(eq(sql`lower(${usersTable.username})`, value))
        .limit(1)
    )[0]?.email?.toLowerCase() ?? value
  );
}

// login signs in with email or username + password (Better Auth, ADR-0014). The caller
// must then send a code to `verifyTwoFactorCode`.
export async function login(
  identifier: string,
  password: string,
): Promise<LoginResult> {
  const normalized = await emailForIdentifier(identifier);
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

// Re-hash a just-proven password when the stored one was made with a weaker setting
// than hashPassword now uses. What it must never do is make a correct password look wrong.
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
    // A failed re-hash must never make a correct password look wrong.
  }
}

// Better Auth's own codes for "those credentials are wrong", and nothing else.
function isCredentialRejection(e: unknown): boolean {
  const code = (e as { body?: { code?: string } } | null)?.body?.code;
  return (
    code === "INVALID_EMAIL_OR_PASSWORD" ||
    code === "USER_NOT_FOUND" ||
    code === "INVALID_PASSWORD" ||
    code === "CREDENTIAL_ACCOUNT_NOT_FOUND"
  );
}

// verifyTwoFactorCode finishes a login that stopped at `requiresTwoFactor`, with a TOTP
// code or one of the account's single-use backup codes.
export async function verifyTwoFactorCode(
  code: string,
  kind: "totp" | "backup",
): Promise<{ ok: boolean; error?: string }> {
  const auth = requireAuth();
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

// passkeyChallenge is what the browser hands to `navigator.credentials.get` to sign in.
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

// verifyPasskeyLogin finishes a passkey sign-in with what the authenticator produced.
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

// startSessionFor signs a freshly created account in and makes a team active. A brand-new
// account can never have 2FA, so there is no challenge branch to handle here.
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

// logout deletes the session ROW (so the token is dead everywhere, not merely forgotten
// by this browser) and clears both cookies. Best-effort on the Better Auth side.
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
