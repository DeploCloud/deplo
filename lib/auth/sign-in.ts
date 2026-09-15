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
  requiresTwoFactor?: boolean;
}

// An unknown username falls through unchanged: no answer here differs, so this is not an account-existence oracle.
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
    await keepAuthCookiesUsableOverHttp();
    // Suspension is checked only after the password verified, so it is never a pre-auth account-existence oracle.
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
    // Fire-and-forget on purpose: a failed re-hash must never make a correct password look wrong.
    void upgradePasswordHash(normalized, password);
    if (res && "twoFactorRedirect" in res && res.twoFactorRedirect)
      return { ok: false, requiresTwoFactor: true };
    return { ok: true };
  } catch (e) {
    if (isCredentialRejection(e))
      return { ok: false, error: "Invalid email or password" };
    throw e;
  }
}

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
      .set({ password: fresh, updatedAt: new Date() })
      .where(
        and(
          eq(accountTable.id, row.id),
          // The old hash is in the WHERE: a password changed in another tab must not be reverted by this re-hash.
          eq(accountTable.password, row.password),
        ),
      );
  } catch {}
}

function isCredentialRejection(e: unknown): boolean {
  const code = (e as { body?: { code?: string } } | null)?.body?.code;
  return (
    code === "INVALID_EMAIL_OR_PASSWORD" ||
    code === "USER_NOT_FOUND" ||
    code === "INVALID_PASSWORD" ||
    code === "CREDENTIAL_ACCOUNT_NOT_FOUND"
  );
}

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
    const message = e instanceof Error ? e.message : "";
    return { ok: false, error: message || "That code is not valid" };
  }
}

export async function passkeyChallenge(): Promise<unknown> {
  if (!passkeyRelyingParty())
    throw new Error(
      "Passkeys need this panel to be reachable at its own https address.",
    );
  return requireAuth().api.generatePasskeyAuthenticationOptions({
    headers: await authHeaders(),
  });
}

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
    await markSessionAuthMethod(res.session.id, res.user.id, "passkey");
  } catch (e) {
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

export async function startSessionFor(
  email: string,
  password: string,
  teamId?: string,
): Promise<void> {
  await requireAuth().api.signInEmail({
    body: { email: email.toLowerCase().trim(), password },
    headers: await authHeaders(),
    asResponse: false,
  });
  await keepAuthCookiesUsableOverHttp();
  if (teamId) await setActiveTeamCookie(teamId);
}

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
