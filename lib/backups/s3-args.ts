/**
 * A backup destination's advanced S3 flags.
 *
 * Every S3-compatible store is compatible in its own way, and the ones that need
 * a workaround need a different one each: a gateway that rejects a signature
 * covering `Accept-Encoding`, a MinIO on a self-signed certificate, a store that
 * only answers path-style. Growing a checkbox per quirk would put four settings
 * on a form where nobody needs any of them, and each new one would be a schema
 * change; so the operator writes the flags, the same way they would for the tools
 * they already reach for when a bucket misbehaves.
 *
 * It is an ALLOWLIST, and that is the whole design. A free-form box that accepts
 * anything and silently drops what it cannot use is worse than no box: the flag
 * looks applied, the gateway keeps failing, and nothing anywhere says why. Here a
 * flag Deplo does not know is refused at the form, by name, with the list of the
 * ones it does.
 *
 * Pure and client-safe (no `server-only`): the dialog shows the same verdict the
 * data layer enforces, so what the operator reads while typing is what the server
 * will say.
 */

/** At most this many flags — a destination has a quirk or two, not a config file. */
export const S3_ARGS_MAX_TOKENS = 8;
/** At most this many characters per flag. */
export const S3_ARGS_MAX_TOKEN_LENGTH = 128;

/**
 * The flags the agent maps onto its minio client, and what each one is for.
 * Mirrored by `parseExtraArgs` in the agent's `internal/s3client`, which drops
 * anything it does not know rather than failing a backup over it.
 */
export const S3_ARGS_ALLOWED: Record<string, string> = {
  "--s3-sign-accept-encoding":
    "Whether Accept-Encoding takes part in the request signature. Set it false for a gateway that rejects the signature Deplo sends.",
  "--s3-force-path-style":
    "Address the bucket in the URL path instead of the hostname. Deplo already picks this from the provider; set it to override.",
  "--s3-insecure-skip-verify":
    "Accept any TLS certificate from the endpoint — for a self-hosted store on a self-signed certificate.",
  "--s3-disable-content-sha256":
    "Upload without the streaming content hash, for a gateway that rejects it.",
};

/** Every character one of these flags is made of. An allowlist, so a quote, a
 *  space inside a token, `;`, `&`, `|` or `$` is refused without enumerating
 *  what someone might try. */
const TOKEN_RE = /^[A-Za-z0-9._:/=,+@-]+$/;

/** Split the stored string into flags (whitespace-separated, no quoting) —
 *  exactly the elements the agent receives. */
export function parseS3Args(raw: string | null | undefined): string[] {
  return (raw ?? "").trim().split(/\s+/).filter(Boolean);
}

/** The flags Deplo understands, as one line for an error message. */
function allowedList(): string {
  return Object.keys(S3_ARGS_ALLOWED).join(", ");
}

/**
 * Why these flags can't be used, or null when they are fine. One message, naming
 * the token at fault: the field is advanced, but "invalid input" would still
 * leave the operator guessing which of four flags Deplo objected to.
 */
export function validateS3Args(raw: string): string | null {
  const tokens = parseS3Args(raw);
  if (tokens.length === 0) return null;
  if (tokens.length > S3_ARGS_MAX_TOKENS)
    return `That is ${tokens.length} flags — ${S3_ARGS_MAX_TOKENS} is the most a destination can take.`;
  for (const token of tokens) {
    if (token.length > S3_ARGS_MAX_TOKEN_LENGTH)
      return `"${token.slice(0, 20)}…" is longer than ${S3_ARGS_MAX_TOKEN_LENGTH} characters.`;
    if (!TOKEN_RE.test(token))
      return `"${token}" isn't a plain flag. Write each one separately as --flag=value, with no quotes and no shell syntax.`;
    const eq = token.indexOf("=");
    if (eq < 0)
      return `"${token}" needs a value, like ${token}=true.`;
    const name = token.slice(0, eq);
    const value = token.slice(eq + 1);
    if (!(name in S3_ARGS_ALLOWED))
      return `Deplo doesn't know "${name}". The flags it applies are: ${allowedList()}.`;
    if (value !== "true" && value !== "false")
      return `"${name}" takes true or false, not "${value}".`;
  }
  return null;
}
