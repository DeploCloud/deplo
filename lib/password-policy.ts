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

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

// Unambiguous characters only (no l/I/O/0/1): a generated password gets read
// aloud, pasted into a chat and typed by hand into a browser prompt. The
// symbols are RFC 3986 unreserved/sub-delims, so no context has to escape them.
const GEN_LOWER = "abcdefghijkmnopqrstuvwxyz";
const GEN_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const GEN_DIGIT = "23456789";
const GEN_SYMBOL = "!*+-._~";
const GEN_ALL = GEN_LOWER + GEN_UPPER + GEN_DIGIT + GEN_SYMBOL;

/** Uniform index below `n`, rejecting the byte range's biased tail. */
function randomBelow(n: number): number {
  const limit = 256 - (256 % n);
  const b = new Uint8Array(1);
  do crypto.getRandomValues(b);
  while (b[0] >= limit);
  return b[0] % n;
}

const pick = (set: string): string => set[randomBelow(set.length)];

/**
 * A suggestion for every "Generate" affordance. It lives here because it has to
 * satisfy PASSWORD_RULES by construction - one of each class, then filled and
 * shuffled - or the button hands the user something the gate rejects.
 */
export function generatePassword(length = 20): string {
  const out = [
    pick(GEN_LOWER),
    pick(GEN_UPPER),
    pick(GEN_DIGIT),
    pick(GEN_SYMBOL),
  ];
  while (out.length < Math.max(length, PASSWORD_MIN_LENGTH))
    out.push(pick(GEN_ALL));
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomBelow(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.join("");
}
