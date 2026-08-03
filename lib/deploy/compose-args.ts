/**
 * The app's own extra `docker compose up` flags.
 *
 * deplo assembles the bring-up itself — the project name keys every container and
 * label, the stack file is the compose it just rendered, the env-file holds the
 * decrypted secrets. What an operator sometimes needs is one more FLAG on that
 * command (`--pull always`, `--force-recreate`, `--scale web=3`), and until now
 * there was nowhere to put it.
 *
 * So this is deliberately NOT the "custom command" other platforms ship, where
 * you retype the whole invocation from whatever the UI currently prints. That
 * design breaks twice: the day deplo changes its own command, every hand-copied
 * override silently keeps running the old one; and one typo in the project name
 * or stack path points compose at nothing, which looks like a green deploy of an
 * app that never restarted. Here the operator adds only the part that is theirs,
 * deplo keeps owning the rest, and both sides — control plane and agent — refuse
 * the flags that would take that ownership away.
 *
 * Pure and client-safe (no `server-only`): the settings form previews the exact
 * command with the same functions the deploy path uses, so what the user reads is
 * what the host runs.
 */

/** At most this many tokens — a bring-up is a flag or two, not a script. */
export const COMPOSE_UP_ARGS_MAX_TOKENS = 24;
/** At most this many characters per token. */
export const COMPOSE_UP_ARGS_MAX_TOKEN_LENGTH = 128;

/**
 * The flags that decide WHICH stack is coming up. They are deplo's to set, so
 * they can never be overridden here — mirrored by `composeArgDenied` in the
 * agent, which drops the whole set if one arrives anyway.
 */
const DENIED = new Set([
  "-p",
  "--project-name",
  "-f",
  "--file",
  "--env-file",
  "--project-directory",
]);

/** Every character a real compose flag or value is made of. An allowlist, so a
 * quote, a space inside a token, `;`, `&`, `|`, `$` or a control character is
 * refused without having to enumerate what people might try. */
const TOKEN_RE = /^[A-Za-z0-9._:/=,+@-]+$/;

/** Split the stored string into argv tokens (whitespace-separated, no quoting —
 * one token per element, exactly as the agent receives them). */
export function parseComposeUpArgs(raw: string | null | undefined): string[] {
  return (raw ?? "").trim().split(/\s+/).filter(Boolean);
}

/**
 * Why this set of flags can't be used, or null when it is fine. One message,
 * naming the token at fault — the field is advanced, but "invalid input" would
 * still leave the operator guessing which of six flags deplo objected to.
 */
export function validateComposeUpArgs(raw: string): string | null {
  const tokens = parseComposeUpArgs(raw);
  if (tokens.length === 0) return null;
  if (tokens.length > COMPOSE_UP_ARGS_MAX_TOKENS)
    return `That is ${tokens.length} arguments — ${COMPOSE_UP_ARGS_MAX_TOKENS} is the most a bring-up can take.`;
  if (!tokens[0].startsWith("-"))
    return `Extra flags only: "${tokens[0]}" isn't one. Deplo already supplies "docker compose … up -d", so start with a flag like --pull.`;
  for (const token of tokens) {
    if (token.length > COMPOSE_UP_ARGS_MAX_TOKEN_LENGTH)
      return `"${token.slice(0, 20)}…" is longer than ${COMPOSE_UP_ARGS_MAX_TOKEN_LENGTH} characters.`;
    if (!TOKEN_RE.test(token))
      return `"${token}" isn't a plain flag or value. Write each one separately, with no quotes, and no shell syntax — the command is run directly, not through a shell.`;
    const name = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    if (DENIED.has(name))
      return `"${name}" is Deplo's to set — it decides which stack comes up. Everything else is yours.`;
  }
  return null;
}

/**
 * The full command the owning server will run, for the settings page to show
 * live. Built from the same pieces the agent uses (`internal/server/deploy.go`
 * composeUpArgs), so the preview is the command, not a description of it.
 */
export function composeUpCommandPreview(opts: {
  slug: string;
  /** Compose stacks interpolate `${VAR}` and therefore get an env-file; a
   * single-image app has its env baked into the rendered YAML. */
  usesEnvFile: boolean;
  /** The operator's extra flags, already parsed. */
  extra: string[];
}): string {
  const stack = `/data/stacks/${opts.slug}.yml`;
  const parts = ["docker", "compose", "-p", `deplo-${opts.slug}`, "-f", stack];
  if (opts.usesEnvFile) parts.push("--env-file", `/data/stacks/${opts.slug}.env`);
  parts.push("up", "-d", "--remove-orphans", ...opts.extra);
  return parts.join(" ");
}
