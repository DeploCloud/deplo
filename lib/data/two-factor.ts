import "server-only";

// https://deplo.build/docs/guides/account-security

import {
  assertUser,
  authHeaders,
  verifyTwoFactorCode,
  verifyUserPassword,
} from "../auth";
import { requireAuth } from "../auth/better-auth";
import { requirePersonalSession } from "../auth/request-context";
import { twoFactorMandateForCurrentUser } from "../membership";
import { userHasPasskey } from "../passkey-policy";
import { rateLimit } from "../security";

/**
 * Turning two-factor on, off, and minting fresh recovery codes. The one exception
 * is first enrolment: there is no second factor to ask for yet, and adding one is
 * not a downgrade.
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
 */
export async function stepUpPassword(password: string) {
  const user = await assertUser();
  const limit = await rateLimit(`2fa-step-up:${user.id}`, STEP_UP_LIMIT);
  if (!limit.ok)
    throw new Error(`Too many attempts. Try again in ${limit.retryAfterSec}s.`);
  if (!(await verifyUserPassword(user.id, password)))
    throw new Error("That password is not correct");
  return user;
}

/**
 * Confirm the second-factor half.
 */
export async function stepUpCode(code: string) {
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
  // `method` is explicit, and the narrowing below is not ceremony. ("totp" is also
  // the plugin's default; naming it is what keeps a future default flip from silently
  // emptying the enrolment wizard.)
  const res = await requireAuth().api.enableTwoFactor({
    body: { password, method: "totp" },
    headers: await authHeaders(),
  });
  if (res.method !== "totp")
    throw new Error(
      "Two-factor setup could not produce a code for your authenticator app. Try again.",
    );
  return { totpUri: res.totpURI, recoveryCodes: res.backupCodes };
}

/**
 * Finish enrolment with the first code the authenticator app produces. No
 * password: it was taken at the start of the wizard, and the pending secret is
 * worthless to anyone who cannot read a code off it.
 */
export async function confirmTwoFactorEnrolment(code: string): Promise<void> {
  requirePersonalSession("two-factor settings");
  const user = await assertUser();
  const limit = await rateLimit(`2fa-step-up:${user.id}`, STEP_UP_LIMIT);
  if (!limit.ok)
    throw new Error(`Too many attempts. Try again in ${limit.retryAfterSec}s.`);
  await stepUpCode(code);
}

/**
 * Turn two-factor off. Checked before the code is verified so a refusal never
 * burns one of the user's recovery codes.
 */
export async function disableTwoFactor(input: {
  password: string;
  code: string;
}): Promise<void> {
  requirePersonalSession("two-factor settings");
  const user = await stepUpPassword(input.password);
  const mandate = (await userHasPasskey(user.id))
    ? null
    : await twoFactorMandateForCurrentUser();
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
