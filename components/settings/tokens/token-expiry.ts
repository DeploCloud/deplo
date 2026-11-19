/** Expiry choices for a token, shared by the editor and the reroll dialog. */
export const TOKEN_EXPIRY_CHOICES = [
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In a year" },
  { value: "never", label: "Never" },
] as const;

/** Matches DEFAULT_TOKEN_DAYS on the server. */
export const DEFAULT_TOKEN_EXPIRY = "90";

/** `keep` leaves the expiry alone, `never` clears it, a number is days from now. */
export function expiresAtFor(choice: string): string | null | undefined {
  if (choice === "keep") return undefined;
  if (choice === "never") return null;
  const days = Number(choice);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
