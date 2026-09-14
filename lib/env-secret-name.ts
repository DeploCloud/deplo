// Mirrors buildkit's `SecretsUsedInArgOrEnv` name check.
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

// buildkit exempts these: `PUBLIC_KEY` is public, `TOKEN_FILE` a path, `API_VERSION` metadata.
const ALLOWED_WORDS = ["public", "file", "version"];

const word = (list: string[]) =>
  new RegExp(`(?:_|^)(?:${list.join("|")})(?:_|$)`, "i");

const SENSITIVE = word(SENSITIVE_WORDS);
const ALLOWED = word(ALLOWED_WORDS);

// envNameLooksSensitive answers what a Docker build would flag, without waiting for a build.
export function envNameLooksSensitive(key: string): boolean {
  return SENSITIVE.test(key) && !ALLOWED.test(key);
}
