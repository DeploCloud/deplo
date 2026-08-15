import "server-only";

import { cache } from "react";
import { and, eq, sql } from "drizzle-orm";

import {
  assertUser,
  authHeaders,
  currentSessionId,
  markSessionAuthMethod,
} from "../auth";
import { requireAuth } from "../auth/better-auth";
import { requirePersonalSession } from "../auth/request-context";
import { getDb } from "../db/client";
import { memberships, passkey as passkeyTable } from "../db/schema";
import { twoFactorMandateForCurrentUser } from "../membership";
import { passkeyRelyingParty } from "../public-url";
import { recordActivity } from "./activity";
import { stepUpPassword } from "./two-factor";

/**
 * The account's passkeys - Settings -> Security.
 *
 * USER-scoped, never team-scoped, for the same reason `lib/data/sessions.ts` is:
 * a credential belongs to a person. Everything here resolves through
 * `assertUser()` and refuses an API token ({@link requirePersonalSession}) - a
 * bearer credential should not be able to mint the credential that replaces the
 * password, and "add a passkey" is not a thing a CI job does.
 *
 * **Only the two registration steps go through the plugin; everything else is
 * Drizzle.** Registration must stay on the endpoints, because that is where the
 * single-use challenge is consumed and the assertion verified - nothing here
 * could reimplement it safely. The rest is row work with an ownership check, and
 * doing it locally buys two things the endpoints cannot: the "is this your last
 * second factor" guard shares ONE transaction with the delete it guards (routed
 * through the plugin, that check would race its own delete), and the read is a
 * four-column projection, so `public_key` never enters this process's memory.
 * This is not the `lib/data/sessions.ts` rule being ignored - that rule exists
 * because a raw session delete stops revoking anything the day someone turns on
 * `secondaryStorage`, and a passkey row has no such second home.
 *
 * Step-up is the PASSWORD, shared with two-factor: `stepUpPassword` and its
 * per-account limiter are imported rather than re-created, so six wrong guesses
 * buy the same pause whichever credential the person is changing. Adding or
 * removing one needs it; renaming does not - a label is not a credential.
 */

/** More than this and the list stops being something a person can read. */
const MAX_PASSKEYS = 20;

export interface PasskeyDTO {
  id: string;
  /** The label the person gave it, e.g. "Chrome on macOS". */
  name: string;
  /** Null only for a row written before the plugin started stamping it. */
  createdAt: string | null;
  /**
   * False for a credential minted for a DIFFERENT panel address (or before deplo
   * recorded which). The browser will not offer it here, so it is dead weight -
   * listed anyway, because the only thing to do with it is remove it, and a row
   * that vanished silently would be a credential nobody can account for.
   */
  usableHere: boolean;
}

/** The passkeys on this account, newest first. */
export const listMyPasskeys = cache(async (): Promise<PasskeyDTO[]> => {
  requirePersonalSession("your passkeys");
  const user = await assertUser();
  const rpId = passkeyRelyingParty()?.rpId ?? null;
  const rows = await getDb()
    .select({
      id: passkeyTable.id,
      name: passkeyTable.name,
      createdAt: passkeyTable.createdAt,
      rpId: passkeyTable.rpId,
    })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, user.id))
    // NULLS LAST, not the Postgres default: a row with no timestamp is the
    // oldest thing here, and defaulting it to the top of a "newest first" list
    // would be the one place the order lies.
    .orderBy(sql`${passkeyTable.createdAt} desc nulls last`);
  return rows.map((r) => ({
    id: r.id,
    // The column is nullable because the library can write `undefined`; deplo
    // always sends a label, so this only covers a row it did not create.
    name: r.name?.trim() || "Passkey",
    createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    usableHere: rpId !== null && r.rpId === rpId,
  }));
});

/**
 * Begin registration: the creation options the browser hands to
 * `navigator.credentials.create`.
 *
 * The label is NOT passed as `query.name` even though the plugin accepts it
 * there - that value becomes the WebAuthn `userName`, i.e. what the
 * authenticator displays as the ACCOUNT ("Chrome on macOS" would then be the
 * name of the account, not of the key). The label rides
 * {@link finishPasskeyRegistration} instead.
 */
export async function startPasskeyRegistration(
  password: string,
): Promise<unknown> {
  requirePersonalSession("your passkeys");
  if (!passkeyRelyingParty())
    throw new Error(
      "Passkeys need this panel to be reachable at its own https address.",
    );
  const user = await stepUpPassword(password);
  // A ceiling rather than a rate limit: the step-up limiter already bounds how
  // FAST these arrive, and nothing about the feature needs an unbounded list.
  if ((await countMyPasskeys(user.id)) >= MAX_PASSKEYS)
    throw new Error(
      `This account already has ${MAX_PASSKEYS} passkeys. Remove one before adding another.`,
    );
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
 * to a cookie, expires in five minutes and is consumed on first use - the same
 * argument `confirmTwoFactorEnrolment` makes for the second half of enrolment.
 *
 * Two stamps follow, and both are best-effort. The rpID goes on the credential,
 * because the plugin does not record it and a passkey whose hostname is unknown
 * cannot be told apart from one that still works. The SESSION is marked as
 * passkey-authenticated, because registering one is a user-verified ceremony on
 * the device holding this session - the same proof a sign-in gives. That second
 * stamp is what turns the two-factor lock screen into a way out: somebody who
 * signed in with their password, met a mandate they cannot satisfy, and added a
 * passkey right there is unblocked by the act of adding it, rather than being
 * told to sign out and come back.
 *
 * A failed stamp leaves the safe state in both cases: an unstamped credential
 * reads as "not usable here", and an unstamped session reads as a password one.
 */
export async function finishPasskeyRegistration(input: {
  response: unknown;
  name: string;
}): Promise<PasskeyDTO> {
  requirePersonalSession("your passkeys");
  const user = await assertUser();
  const rpId = passkeyRelyingParty()?.rpId ?? null;
  const name = input.name.trim().slice(0, 64) || "Passkey";
  const row = await requireAuth().api.verifyPasskeyRegistration({
    body: { response: input.response, name },
    headers: await authHeaders(),
  });
  if (rpId)
    await getDb()
      .update(passkeyTable)
      .set({ rpId })
      .where(and(eq(passkeyTable.id, row.id), eq(passkeyTable.userId, user.id)));
  const sessionId = await currentSessionId();
  if (sessionId) await markSessionAuthMethod(sessionId, user.id, "passkey");
  await announce(user.id, user.username, `Added the ${name} passkey`);
  return {
    id: row.id,
    name,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt.toISOString() : null,
    usableHere: rpId !== null,
  };
}

/**
 * Relabel a passkey. No step-up: a label is not a credential.
 *
 * The ownership check is deplo's own even though the plugin's `updatePasskey`
 * carries one. Defense in depth is the house rule, and this is the only gate
 * standing between one account and another's row - leaving it to a library
 * middleware means the boundary moves whenever that library does.
 */
export async function renamePasskey(input: {
  id: string;
  name: string;
}): Promise<void> {
  requirePersonalSession("your passkeys");
  const user = await assertUser();
  const name = input.name.trim().slice(0, 64);
  if (!name) throw new Error("Give this passkey a name");
  const updated = await getDb()
    .update(passkeyTable)
    .set({ name })
    .where(and(eq(passkeyTable.id, input.id), eq(passkeyTable.userId, user.id)))
    .returning({ id: passkeyTable.id });
  if (updated.length === 0)
    throw new Error("That passkey is no longer on this account.");
}

/**
 * Remove a passkey.
 *
 * The mandate guard is the unasked-for consequence of a passkey counting as two
 * factors: for an account with no TOTP, the LAST usable passkey is the only
 * thing satisfying its team's policy, and deleting it would lock the person out
 * of that team with one click and no warning. Checked server-side, like
 * `disableTwoFactor` - the button being disabled in the card is cosmetic.
 *
 * The count and the delete share a transaction, with the account's rows locked
 * `FOR UPDATE`: two "remove" clicks racing each other would otherwise both see
 * two passkeys, both pass the guard, and both delete. The mandate itself is
 * resolved BEFORE the transaction opens, because it queries on its own
 * connection and doing that inside one deadlocks the pglite test harness.
 */
export async function deletePasskey(input: {
  id: string;
  password: string;
}): Promise<void> {
  requirePersonalSession("your passkeys");
  const user = await stepUpPassword(input.password);
  const mandate = user.twoFactorEnabled
    ? null
    : await twoFactorMandateForCurrentUser();
  const rpId = passkeyRelyingParty()?.rpId ?? null;

  const name = await getDb().transaction(async (tx) => {
    const mine = await tx
      .select({ id: passkeyTable.id, name: passkeyTable.name, rpId: passkeyTable.rpId })
      .from(passkeyTable)
      .where(eq(passkeyTable.userId, user.id))
      .for("update");
    const target = mine.find((p) => p.id === input.id);
    if (!target) throw new Error("That passkey is no longer on this account.");
    // Only the ones that still work here count towards the policy: a credential
    // minted for another address satisfies nothing, so removing it can never be
    // what leaves the account short.
    const usable = mine.filter((p) => rpId !== null && p.rpId === rpId);
    const losingTheLastOne =
      usable.length <= 1 && usable.some((p) => p.id === input.id);
    if (mandate && losingTheLastOne)
      throw new Error(
        `${mandate} requires two-factor authentication. Turn on an authenticator app before removing your last passkey.`,
      );
    await tx
      .delete(passkeyTable)
      .where(
        and(eq(passkeyTable.id, input.id), eq(passkeyTable.userId, user.id)),
      );
    return target.name?.trim() || "unnamed";
  });

  await announce(user.id, user.username, `Removed the ${name} passkey`);
}

/** How many passkeys this account holds, usable here or not. */
async function countMyPasskeys(userId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: passkeyTable.id })
    .from(passkeyTable)
    .where(eq(passkeyTable.userId, userId));
  return rows.length;
}

/**
 * File an account-security event in every team the person belongs to.
 *
 * Activity is team-scoped (`listActivity` filters on `teamId`), and a passkey is
 * not - but "somebody welded a new permanent credential onto an account with
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
