const SENSITIVE_WORDS = [
  "apikey",
  "auth",
  "credential",
  "credentials",
  "key",
  "password",
  "pword",
  "passwd",
  "secret",
  "token",
];

const ALLOWED_WORDS = ["public", "file", "version"];

const word = (list: string[]) =>
  new RegExp(`(?:_|^)(?:${list.join("|")})(?:_|$)`, "i");

const SENSITIVE = word(SENSITIVE_WORDS);
const ALLOWED = word(ALLOWED_WORDS);

export function envNameLooksSensitive(key: string): boolean {
  return SENSITIVE.test(key) && !ALLOWED.test(key);
}
