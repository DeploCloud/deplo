import "server-only";

// https://deplo.build/docs/guides/team/account-security

import { assertUser } from "../auth/current-user";
import { verifyUserPassword } from "../auth/password-credential";
import { authHeaders } from "../auth/session-cookies";
import { verifyTwoFactorCode } from "../auth/sign-in";
import { requireAuth } from "../auth/better-auth";
import { requirePersonalSession } from "../auth/request-context";
import { twoFactorMandateForCurrentUser } from "../membership";
import { userHasPasskey } from "../passkey-policy";
import { rateLimit } from "../security";

const STEP_UP_LIMIT = { limit: 6, windowMs: 5 * 60_000 };

export interface TwoFactorEnrolment {
  /** The `otpauth://` URI an authenticator app scans. */
  totpUri: string;
  recoveryCodes: string[];
}

// stepUpPassword confirms the password half of a step-up and returns the account.
export async function stepUpPassword(password: string) {
  const user = await assertUser();
  const limit = await rateLimit(`2fa-step-up:${user.id}`, STEP_UP_LIMIT);
  if (!limit.ok)
    throw new Error(`Too many attempts. Try again in ${limit.retryAfterSec}s.`);
  if (!(await verifyUserPassword(user.id, password)))
    throw new Error("That password is not correct");
  return user;
}

// stepUpCode confirms the second-factor half.
export async function stepUpCode(code: string) {
  const value = code.trim();
  if (!value) throw new Error("Enter a code from your authenticator app");
  // Budgeted HERE, so no caller can offer an unbounded oracle on a six-digit code.
  const user = await assertUser();
  const limit = await rateLimit(`2fa-code:${user.id}`, {
    limit: 10,
    windowMs: 15 * 60_000,
  });
  if (!limit.ok)
    throw new Error(`Too many attempts. Try again in ${limit.retryAfterSec}s.`);
  const res = await verifyTwoFactorCode(
    value,
    /^\d{6}$/.test(value) ? "totp" : "backup",
  );
  if (!res.ok) throw new Error(res.error ?? "That code is not valid");
}

// startTwoFactorEnrolment mints a TOTP secret and a set of recovery codes.
export async function startTwoFactorEnrolment(
  password: string,
): Promise<TwoFactorEnrolment> {
  requirePersonalSession("two-factor settings");
  const user = await stepUpPassword(password);
  if (user.twoFactorEnabled)
    throw new Error(
      "Two-factor is already on for this account. Turn it off first to set up a new device.",
    );
  // "totp" is named explicitly so a future change of the plugin default cannot flip it.
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

// confirmTwoFactorEnrolment finishes enrolment; the password was taken at wizard start.
export async function confirmTwoFactorEnrolment(code: string): Promise<void> {
  requirePersonalSession("two-factor settings");
  const user = await assertUser();
  const limit = await rateLimit(`2fa-step-up:${user.id}`, STEP_UP_LIMIT);
  if (!limit.ok)
    throw new Error(`Too many attempts. Try again in ${limit.retryAfterSec}s.`);
  await stepUpCode(code);
}

// disableTwoFactor refuses before the code is verified, so no recovery code is burnt.
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

// regenerateRecoveryCodes replaces the recovery codes with a fresh set, returned once.
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
