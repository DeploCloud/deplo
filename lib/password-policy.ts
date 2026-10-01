export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 200;

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

export function passwordRuleStatus(password: string): PasswordRuleStatus[] {
  return PASSWORD_RULES.map((rule) => ({
    text: rule.text,
    met: rule.regex.test(password),
  }));
}

export function passwordMeetsPolicy(password: string): boolean {
  return (
    password.length <= PASSWORD_MAX_LENGTH &&
    PASSWORD_RULES.every((rule) => rule.regex.test(password))
  );
}

export function passwordPolicyError(password: string): string | null {
  if (password.length > PASSWORD_MAX_LENGTH)
    return `Choose a password of at most ${PASSWORD_MAX_LENGTH} characters`;
  const missing = passwordRuleStatus(password)
    .filter((rule) => !rule.met)
    .map((rule) => rule.text.replace(/^At least /, ""));
  if (missing.length === 0) return null;
  return `Choose a password with at least: ${missing.join(", ")}`;
}

export function assertPasswordPolicy(password: string): void {
  const error = passwordPolicyError(password);
  if (error) throw new PasswordError(error);
}

export class PasswordError extends Error {
  readonly field = "password" as const;
  constructor(message: string) {
    super(message);
    this.name = "PasswordError";
  }
}

const GEN_LOWER = "abcdefghijkmnopqrstuvwxyz";
const GEN_UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const GEN_DIGIT = "23456789";
const GEN_SYMBOL = "!*+-._~";
const GEN_ALL = GEN_LOWER + GEN_UPPER + GEN_DIGIT + GEN_SYMBOL;

// One getRandomValues call per password, refilled as it runs out, not one per byte.
function randomSource(): (n: number) => number {
  const bytes = new Uint8Array(64);
  let at = bytes.length;
  return (n) => {
    const limit = 256 - (256 % n);
    let b: number;
    do {
      if (at === bytes.length) {
        crypto.getRandomValues(bytes);
        at = 0;
      }
      b = bytes[at++];
    } while (b >= limit);
    return b % n;
  };
}

export function generatePassword(length = 20): string {
  const randomBelow = randomSource();
  const pick = (set: string): string => set[randomBelow(set.length)];
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
