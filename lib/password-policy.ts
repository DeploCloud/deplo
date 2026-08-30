// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The account-password policy, in one place, shared VERBATIM by the browser (the
 * live strength meter) and the server (the real gate). What the meter renders is
 * the same list, so the two can never disagree.
 */

export const PASSWORD_MIN_LENGTH = 8;
/** Matches the zod cap in lib/graphql/types/auth.ts; scrypt does not need more. */
export const PASSWORD_MAX_LENGTH = 200;

/**
 * "Special character" is anything that is not a letter or a digit, rather than
 * a hand-picked punctuation set: a password ending in `~` or a space is not
 * weaker for it, and a list the user has to guess at is a bad field.
 */
export const PASSWORD_RULES = [
  {
    regex: new RegExp(`.{${PASSWORD_MIN_LENGTH},}`),
    text: `At least ${PASSWORD_MIN_LENGTH} characters`,
  },
  { regex: /[0-9]/, text: "At least 1 number" },
  { regex: /[a-z]/, text: "At least 1 lowercase letter" },
  { regex: /[A-Z]/, text: "At least 1 uppercase letter" },
  { regex: /[^A-Za-z0-9]/, text: "At least 1 special character" },
] as const;

export type PasswordRuleStatus = { text: string; met: boolean };

/** Every rule with its verdict, in display order. */
export function passwordRuleStatus(password: string): PasswordRuleStatus[] {
  return PASSWORD_RULES.map((rule) => ({
    text: rule.text,
    met: rule.regex.test(password),
  }));
}

/** True when every rule is met. */
export function passwordMeetsPolicy(password: string): boolean {
  return (
    password.length <= PASSWORD_MAX_LENGTH &&
    PASSWORD_RULES.every((rule) => rule.regex.test(password))
  );
}

/**
 * One message naming everything still missing, or null when the password
 * passes. Phrased as an instruction because it is surfaced verbatim in a toast.
 */
export function passwordPolicyError(password: string): string | null {
  if (password.length > PASSWORD_MAX_LENGTH)
    return `Choose a password of at most ${PASSWORD_MAX_LENGTH} characters`;
  const missing = passwordRuleStatus(password)
    .filter((rule) => !rule.met)
    .map((rule) => rule.text.replace(/^At least /, ""));
  if (missing.length === 0) return null;
  return `Choose a password with at least: ${missing.join(", ")}`;
}

/**
 * The single gate in front of every path that writes a credential: account
 * creation (both flavours), a self-service change, and an admin reset. Throws
 * the message the UI shows verbatim.
 */
export function assertPasswordPolicy(password: string): void {
  const error = passwordPolicyError(password);
  if (error) throw new Error(error);
}
