import "server-only";

import {
  assertUser,
  authHeaders,
  verifyTwoFactorCode,
  verifyUserPassword,
} from "../auth";
import { requireAuth } from "../auth/better-auth";
import { requirePersonalSession } from "../auth/request-context";
import { twoFactorMandateForCurrentUser } from "../membership";
import { rateLimit } from "../security";

/**
 * Turning two-factor on, off, and minting fresh recovery codes.
 *
 * This module exists because Better Auth's twoFactor plugin gates all three on
 * the PASSWORD alone, and the endpoints are closed to the network for exactly
 * that reason (`twoFactorGate` in lib/auth/better-auth.ts). Password-only is one
 * factor below the bar the account itself set: someone holding a stolen session
 * and a phished password could turn 2FA off, or re-run `/two-factor/enable` to
 * swap the secret for one of their own, or quietly mint themselves ten recovery
 * codes while the account still reads "protected".
 *
 * An API token reaches none of it either ({@link requirePersonalSession}): the
 * password re-check already stopped a token from completing any of these, but a
 * credential should not be able to burn an account's step-up rate limit, and the
 * account's own second factor is not a thing a CI job administers.
 *
 * So every state change here is PASSWORD + a live second factor, which is what
 * Google, GitHub and AWS all do for the same operations, and what NIST SP
 * 800-63B means by unbinding an authenticator at the account's own assurance
 * level. The one exception is first enrolment: there is no second factor to ask
 * for yet, and adding one is not a downgrade.
 *
 * The second factor may be a TOTP code OR a recovery code. That is not a
 * convenience: TOTP-only would mean a lost phone leaves 2FA welded on with no
 * way out, and the way out must not be a SQL prompt. `resetTwoFactorForUser`
 * (lib/data/members.ts) is the instance-admin backstop for losing both.
 */

/** How many password/code attempts one account gets before it has to wait. */
const STEP_UP_LIMIT = { limit: 6, windowMs: 5 * 60_000 };

export interface TwoFactorEnrolment {
  /** The `otpauth://` URI an authenticator app scans. */
  totpUri: string;
  recoveryCodes: string[];
}

/**
 * Confirm the password half of a step-up, and return the account it belongs to.
 *
 * Rate limited per ACCOUNT rather than per IP: the thing being guessed is one
 * account's password, and an attacker rotating addresses is the normal case. The
 * limiter is deliberately shared by the password and the code, so six wrong
 * guesses of either kind buys the same pause.
 */
async function stepUpPassword(password: string) {
  const user = await assertUser();
  const limit = rateLimit(`2fa-step-up:${user.id}`, STEP_UP_LIMIT);
  if (!limit.ok)
    throw new Error(`Too many attempts. Try again in ${limit.retryAfterSec}s.`);
  if (!(await verifyUserPassword(user.id, password)))
    throw new Error("That password is not correct");
  return user;
}

/**
 * Confirm the second-factor half.
 *
 * The KIND is derived, not asked: a TOTP code is six digits and a recovery code
 * never is (Better Auth mints them as `xxxxx-xxxxx`), so one field can take
 * either and the person reaching for a recovery code after losing their phone
 * does not first have to find a toggle. A recovery code is consumed by the
 * plugin on success, so this is called only once the action is going to happen.
 */
async function stepUpCode(code: string) {
  const value = code.trim();
  if (!value) throw new Error("Enter a code from your authenticator app");
  const res = await verifyTwoFactorCode(
    value,
    /^\d{6}$/.test(value) ? "totp" : "backup",
  );
  if (!res.ok) throw new Error(res.error ?? "That code is not valid");
}

/**
 * Begin enrolment: mint a TOTP secret and a set of recovery codes.
 *
 * Nothing is switched on yet — `confirmTwoFactorEnrolment` does that once the
 * app has proved it can produce a code. Refused outright when 2FA is already on,
 * because the plugin's `enable` DELETES the existing secret before writing the
 * new one: allowing it here would hand back a re-enrolment path that skips the
 * code the disable path insists on.
 */
export async function startTwoFactorEnrolment(
  password: string,
): Promise<TwoFactorEnrolment> {
  requirePersonalSession("two-factor settings");
  const user = await stepUpPassword(password);
  if (user.twoFactorEnabled)
    throw new Error(
      "Two-factor is already on for this account. Turn it off first to set up a new device.",
    );
  const res = await requireAuth().api.enableTwoFactor({
    body: { password },
    headers: await authHeaders(),
  });
  return { totpUri: res.totpURI, recoveryCodes: res.backupCodes };
}

/**
 * Finish enrolment with the first code the authenticator app produces.
 *
 * No password: it was taken at the start of the wizard, and the pending secret
 * is worthless to anyone who cannot read a code off it. Better Auth flips
 * `twoFactorEnabled` and re-issues the session as part of verifying.
 */
export async function confirmTwoFactorEnrolment(code: string): Promise<void> {
  requirePersonalSession("two-factor settings");
  const user = await assertUser();
  const limit = rateLimit(`2fa-step-up:${user.id}`, STEP_UP_LIMIT);
  if (!limit.ok)
    throw new Error(`Too many attempts. Try again in ${limit.retryAfterSec}s.`);
  await stepUpCode(code);
}

/**
 * Turn two-factor off.
 *
 * The team/role mandate is checked SERVER-SIDE here and not only in the card:
 * the button being disabled is cosmetic, and a policy that only holds in the UI
 * is not a policy. Checked before the code is verified so a refusal never burns
 * one of the user's recovery codes.
 */
export async function disableTwoFactor(input: {
  password: string;
  code: string;
}): Promise<void> {
  requirePersonalSession("two-factor settings");
  await stepUpPassword(input.password);
  const mandate = await twoFactorMandateForCurrentUser();
  if (mandate)
    throw new Error(
      `${mandate} requires two-factor authentication, so it cannot be turned off.`,
    );
  await stepUpCode(input.code);
  await requireAuth().api.disableTwoFactor({
    body: { password: input.password },
    headers: await authHeaders(),
  });
}

/**
 * Replace the recovery codes with a fresh set, returned once.
 *
 * The quiet one, and the reason this module exists: it leaves 2FA switched on
 * and the account looking untouched, so it is the change an attacker would most
 * like to make with a password alone.
 */
export async function regenerateRecoveryCodes(input: {
  password: string;
  code: string;
}): Promise<string[]> {
  requirePersonalSession("two-factor settings");
  await stepUpPassword(input.password);
  await stepUpCode(input.code);
  const res = await requireAuth().api.generateBackupCodes({
    body: { password: input.password },
    headers: await authHeaders(),
  });
  return res.backupCodes;
}
