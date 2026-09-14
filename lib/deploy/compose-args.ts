/** At most this many tokens - a bring-up is a flag or two, not a script. */
export const COMPOSE_UP_ARGS_MAX_TOKENS = 24;
/** At most this many characters per token. */
export const COMPOSE_UP_ARGS_MAX_TOKEN_LENGTH = 128;

// The flags that decide WHICH stack is coming up - mirrored by `composeArgDenied` in the agent.
const DENIED = new Set([
  "-p",
  "--project-name",
  "-f",
  "--file",
  "--env-file",
  "--project-directory",
]);

// An allowlist, so a quote, a space inside a token, `;`, `&`, `|`, `$` or a control character is refused.
const TOKEN_RE = /^[A-Za-z0-9._:/=,+@-]+$/;

/** Split the stored string into argv tokens, exactly as the agent receives them. */
export function parseComposeUpArgs(raw: string | null | undefined): string[] {
  return (raw ?? "").trim().split(/\s+/).filter(Boolean);
}

/** Why this set of flags can't be used, or null when it is fine. */
export function validateComposeUpArgs(raw: string): string | null {
  const tokens = parseComposeUpArgs(raw);
  if (tokens.length === 0) return null;
  if (tokens.length > COMPOSE_UP_ARGS_MAX_TOKENS)
    return `That is ${tokens.length} arguments - ${COMPOSE_UP_ARGS_MAX_TOKENS} is the most a bring-up can take.`;
  if (!tokens[0].startsWith("-"))
    return `Extra flags only: "${tokens[0]}" isn't one. Deplo already supplies "docker compose … up -d", so start with a flag like --pull.`;
  for (const token of tokens) {
    if (token.length > COMPOSE_UP_ARGS_MAX_TOKEN_LENGTH)
      return `"${token.slice(0, 20)}…" is longer than ${COMPOSE_UP_ARGS_MAX_TOKEN_LENGTH} characters.`;
    if (!TOKEN_RE.test(token))
      return `"${token}" isn't a plain flag or value. Write each one separately, with no quotes, and no shell syntax - the command is run directly, not through a shell.`;
    const name = token.includes("=")
      ? token.slice(0, token.indexOf("="))
      : token;
    if (DENIED.has(name))
      return `"${name}" is Deplo's to set - it decides which stack comes up. Everything else is yours.`;
  }
  return null;
}

/** Deploy flags: `--pull always` first, since `docker compose up` alone pulls only what is missing. */
export function composeDeployArgs(extra: string[]): string[] {
  const own = extra.some((t) => t === "--pull" || t.startsWith("--pull="));
  // The agent drops the WHOLE set past its cap, pull included.
  if (own || extra.length + 2 > COMPOSE_UP_ARGS_MAX_TOKENS) return extra;
  return ["--pull", "always", ...extra];
}

/** The full command the owning server will run, for the settings page to show live. */
export function composeUpCommandPreview(opts: {
  slug: string;
  // A compose stack interpolates `${VAR}` and therefore gets an env-file; a single-image app bakes env into the rendered YAML.
  usesEnvFile: boolean;
  extra: string[];
}): string {
  const stack = `/data/stacks/${opts.slug}.yml`;
  const parts = ["docker", "compose", "-p", `deplo-${opts.slug}`, "-f", stack];
  if (opts.usesEnvFile)
    parts.push("--env-file", `/data/stacks/${opts.slug}.env`);
  // A compose stack's deploy pulls (composeDeployArgs); a single-image app's image is pulled or built before the bring-up.
  const extra = opts.usesEnvFile ? composeDeployArgs(opts.extra) : opts.extra;
  parts.push("up", "-d", "--remove-orphans", ...extra);
  return parts.join(" ");
}
