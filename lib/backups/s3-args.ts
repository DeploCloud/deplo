export const S3_ARGS_MAX_TOKENS = 8;
export const S3_ARGS_MAX_TOKEN_LENGTH = 128;

export const S3_ARGS_ALLOWED: Record<string, string> = {
  "--s3-sign-accept-encoding":
    "Whether Accept-Encoding takes part in the request signature. Set it false for a gateway that rejects the signature Deplo sends.",
  "--s3-force-path-style":
    "Address the bucket in the URL path instead of the hostname. Deplo already picks this from the provider; set it to override.",
  "--s3-insecure-skip-verify":
    "Accept any TLS certificate from the endpoint - for a self-hosted store on a self-signed certificate.",
  "--s3-disable-content-sha256":
    "Upload without the streaming content hash, for a gateway that rejects it.",
};

const TOKEN_RE = /^[A-Za-z0-9._:/=,+@-]+$/;

export function parseS3Args(raw: string | null | undefined): string[] {
  return (raw ?? "").trim().split(/\s+/).filter(Boolean);
}

function allowedList(): string {
  return Object.keys(S3_ARGS_ALLOWED).join(", ");
}

export function validateS3Args(raw: string): string | null {
  const tokens = parseS3Args(raw);
  if (tokens.length === 0) return null;
  if (tokens.length > S3_ARGS_MAX_TOKENS)
    return `That is ${tokens.length} flags - ${S3_ARGS_MAX_TOKENS} is the most a destination can take.`;
  for (const token of tokens) {
    if (token.length > S3_ARGS_MAX_TOKEN_LENGTH)
      return `"${token.slice(0, 20)}…" is longer than ${S3_ARGS_MAX_TOKEN_LENGTH} characters.`;
    if (!TOKEN_RE.test(token))
      return `"${token}" isn't a plain flag. Write each one separately as --flag=value, with no quotes and no shell syntax.`;
    const eq = token.indexOf("=");
    if (eq < 0) return `"${token}" needs a value, like ${token}=true.`;
    const name = token.slice(0, eq);
    const value = token.slice(eq + 1);
    // An allowlist: a real flag the agent has no mapping for must be refused, never accepted and silently dropped.
    if (!(name in S3_ARGS_ALLOWED))
      return `Deplo doesn't know "${name}". The flags it applies are: ${allowedList()}.`;
    if (value !== "true" && value !== "false")
      return `"${name}" takes true or false, not "${value}".`;
  }
  return null;
}
