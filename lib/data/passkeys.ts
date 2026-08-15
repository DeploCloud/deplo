import "server-only";

import { cache } from "react";
import { and, desc, eq } from "drizzle-orm";

import { assertUser, authHeaders } from "../auth";
import { requireAuth } from "../auth/better-auth";
import { requirePersonalSession } from "../auth/request-context";
import { getDb } from "../db/client";
import { memberships, passkey as passkeyTable } from "../db/schema";
import { twoFactorMandateForCurrentUser } from "../membership";
import { recordActivity } from "./activity";
import { stepUpPassword } from "./two-factor";

/**
 * The account's passkeys — Settings → Security.
 *
 * USER-scoped, never team-scoped, for the same reason `lib/data/sessions.ts` is:
 * a credential belongs to a person. Everything here resolves through
 * `assertUser()` and refuses an API token ({@link requirePersonalSession}) — a
 * bearer credential should not be able to mint the credential that replaces the
 * password, and "add a passkey" is not a thing a CI job does.
 *
 * **Reads go through Drizzle, writes through the plugin's endpoints.** That is
 * the opposite of the rule `lib/data/sessions.ts` argues for, on purpose: that
 * rule exists because a raw DELETE on `session` would silently stop revoking
 * anything the day someone turns on `secondaryStorage` or `session.cookieCache`,
 * and a passkey row has no such second home. What the endpoints DO own is the
 * part that cannot be reimplemented safely — consuming the single-use challenge,
 * verifying the assertion, and the ownership check on delete/update — so every
 * write stays there. The read is a three-column projection precisely so that
 * `public_key` never enters this process's memory. Don't "fix" either half.
 *
 * Step-up is the PASSWORD, shared with two-factor: `stepUpPassword` and its
 * per-account limiter are imported rather than re-created, so six wrong guesses
 * buy the same pause whichever credential the person is changing. Adding or
 * removing a passkey needs it; renaming one does not — a label is not a
 * credential, and the plugin's `requireResourceOwnership` already answers "is
 * this yours".
 */

export interface PasskeyDTO {
  id: string;
  /** The label the person gave it, e.g. "Chrome on macOS". */
  name: string;
  /** Null only for a row written before the plugin started stamping it. */
  createdAt: string | null;
}

/** The passkeys on this account, newest first. */
export const listMyPasskeys = cache(async (): Promise<PasskeyDTO[]> => {
  requirePersonalSession("your passkeys");
  const user = await assertUser();
  const rows = await getDb()
    .select({
      id: passkeyTable.id,
      name: passkeyTable.name,
      createdAt: passkeyTable.createdAt,
    })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, user.id))
    .orderBy(desc(passkeyTable.createdAt));
  return rows.map((r) => ({
    id: r.id,
    // The column is nullable because the library can write `undefined`; deplo
    // always sends a label, so this only covers a row it did not create.
    name: r.name?.trim() || "Passkey",
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
  }));
});

/** Whether this account holds at least one passkey. */
async function countMyPasskeys(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: passkeyTable.id })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId));
  return rows.length;
}

/**
 * Begin registration: the creation options the browser hands to
 * `navigator.credentials.create`.
 *
 * The label is NOT passed as `query.name` even though the plugin accepts it
 * there — that value becomes the WebAuthn `userName`, i.e. what the
 * authenticator displays as the ACCOUNT ("Chrome on macOS" would then be the
 * name of the account, not of the key). The label rides
 * {@link finishPasskeyRegistration} instead.
 */
export async function startPasskeyRegistration(
  password: string,
): Promise<unknown> {
  requirePersonalSession("your passkeys");
  await stepUpPassword(password);
  return requireAuth().api.generatePasskeyRegistrationOptions({
    query: {},
    headers: await authHeaders(),
  });
}

/**
 * Finish registration with what the authenticator produced.
 *
 * No second password prompt: the challenge this response answers was minted by
 * {@link startPasskeyRegistration} moments ago behind that exact check, is bound
 * to a cookie, expires in five minutes and is consumed on first use — the same
 * argument `confirmTwoFactorEnrolment` makes for the second half of enrolment.
 */
export async function finishPasskeyRegistration(input: {
  response: unknown;
  name: string;
}): Promise<PasskeyDTO> {
  requirePersonalSession("your passkeys");
  const user = await assertUser();
  const name = input.name.trim().slice(0, 64) || "Passkey";
  const row = await requireAuth().api.verifyPasskeyRegistration({
    body: { response: input.response, name },
    headers: await authHeaders(),
  });
  await announce(user.id, user.username, `Added the ${name} passkey`);
  return {
    id: row.id,
    name,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : null,
  };
}

/** Relabel a passkey. No step-up: a label is not a credential. */
export async function renamePasskey(input: {
  id: string;
  name: string;
}): Promise<void> {
  requirePersonalSession("your passkeys");
  await assertUser();
  const name = input.name.trim().slice(0, 64);
  if (!name) throw new Error("Give this passkey a name");
  await requireAuth().api.updatePasskey({
    body: { id: input.id, name },
    headers: await authHeaders(),
  });
}

/**
 * Remove a passkey.
 *
 * The mandate guard is the unasked-for consequence of a passkey counting as two
 * factors: for an account with no TOTP, the LAST passkey is the only thing
 * satisfying its team's policy, and deleting it would lock the person out of
 * that team with one click and no warning. Checked server-side and before the
 * delete, exactly like `disableTwoFactor` — the button being disabled in the
 * card is cosmetic.
 */
export async function deletePasskey(input: {
  id: string;
  password: string;
}): Promise<void> {
  requirePersonalSession("your passkeys");
  const user = await stepUpPassword(input.password);
  if (!user.twoFactorEnabled && (await countMyPasskeys(user.id)) <= 1) {
    const mandate = await twoFactorMandateForCurrentUser();
    if (mandate)
      throw new Error(
        `${mandate} requires two-factor authentication. Turn on an authenticator app before removing your last passkey.`,
      );
  }
  const rows = await getDb()
    .select({ name: passkeyTable.name })
    .from(passkeyTable)
    .where(and(eq(passkeyTable.id, input.id), eq(passkeyTable.userId, user.id)))
    .limit(1);
  if (!rows[0]) throw new Error("That passkey is no longer on this account.");
  await requireAuth().api.deletePasskey({
    body: { id: input.id },
    headers: await authHeaders(),
  });
  await announce(
    user.id,
    user.username,
    `Removed the ${rows[0].name?.trim() || "unnamed"} passkey`,
  );
}

/**
 * File an account-security event in every team the person belongs to.
 *
 * Activity is team-scoped (`listActivity` filters on `teamId`), and a passkey is
 * not — but "somebody welded a new permanent credential onto an account with
 * access to our fleet" is exactly the question a company has to be able to
 * answer in the UI. So the row is written per team rather than once and nowhere.
 *
 * `teamId` is passed explicitly for the same reason: left null, `recordActivity`
 * falls back to the first team by creation order, which for an account-level
 * event means filing it under a team the person may not even be in.
 */
async function announce(
  userId: string,
  actor: string,
  message: string,
): Promise<void> {
  const rows = await getDb()
    .select({ teamId: memberships.teamId })
    .from(memberships)
    .where(eq(memberships.userId, userId));
  for (const { teamId } of rows)
    await recordActivity("member", message, actor, null, teamId);
}
