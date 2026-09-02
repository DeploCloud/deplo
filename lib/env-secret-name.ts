/**
 * Docker's own build-lint rule for a variable NAME that looks like a secret
 * (buildkit's `SecretsUsedInArgOrEnv`): a `_`-delimited word from the deny list,
 * unless an allow word sits in the name too.
 */

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

/** `PUBLIC_KEY` is meant to be public, `TOKEN_FILE` names a path, `API_VERSION`
 *  is metadata - buildkit exempts all three. */
const ALLOWED_WORDS = ["public", "file", "version"];

const word = (list: string[]) =>
  new RegExp(`(?:_|^)(?:${list.join("|")})(?:_|$)`, "i");

const SENSITIVE = word(SENSITIVE_WORDS);
const ALLOWED = word(ALLOWED_WORDS);

/**
 * Whether a Docker build would flag this variable name as sensitive - the same
 * verdict the build log prints, without waiting for a build.
 */
export function envNameLooksSensitive(key: string): boolean {
  return SENSITIVE.test(key) && !ALLOWED.test(key);
}
