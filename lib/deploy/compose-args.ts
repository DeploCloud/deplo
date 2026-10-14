export const COMPOSE_UP_ARGS_MAX_TOKENS = 24;
export const COMPOSE_UP_ARGS_MAX_TOKEN_LENGTH = 128;

const DENIED = new Set([
  "-p",
  "--project-name",
  "-f",
  "--file",
  "--env-file",
  "--project-directory",
]);

// An allowlist of `compose up`'s own flags: a glued `-pNAME` or `-f/path` is no denied token.
const ALLOWED = new Set([
  "--abort-on-container-exit",
  "--abort-on-container-failure",
  "--always-recreate-deps",
  "--attach",
  "--attach-dependencies",
  "--build",
  "-d",
  "--detach",
  "--dry-run",
  "--exit-code-from",
  "--force-recreate",
  "--menu",
  "--no-attach",
  "--no-build",
  "--no-color",
  "--no-deps",
  "--no-log-prefix",
  "--no-recreate",
  "--no-start",
  "--profile",
  "--pull",
  "--quiet-build",
  "--quiet-pull",
  "--remove-orphans",
  "-V",
  "--renew-anon-volumes",
  "--scale",
  "-t",
  "--timeout",
  "--timestamps",
  "--wait",
  "--wait-timeout",
  "-w",
  "--watch",
  "-y",
  "--yes",
]);

const TOKEN_RE = /^[A-Za-z0-9._:/=,+@-]+$/;

export function parseComposeUpArgs(raw: string | null | undefined): string[] {
  return (raw ?? "").trim().split(/\s+/).filter(Boolean);
}

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
      return `"${name}" is Deplo's to set - it decides which stack comes up.`;
    if (token.startsWith("-") && !ALLOWED.has(name))
      return `"${name}" isn't a flag of compose up. Write each flag in full, like --wait or --timeout=60.`;
  }
  return null;
}

export function composeDeployArgs(extra: string[]): string[] {
  const own = extra.some((t) => t === "--pull" || t.startsWith("--pull="));
  if (own || extra.length + 2 > COMPOSE_UP_ARGS_MAX_TOKENS) return extra;
  return ["--pull", "always", ...extra];
}

export function composeUpCommandPreview(opts: {
  slug: string;
  usesEnvFile: boolean;
  extra: string[];
}): string {
  const stack = `/data/stacks/${opts.slug}.yml`;
  const parts = ["docker", "compose", "-p", `deplo-${opts.slug}`, "-f", stack];
  if (opts.usesEnvFile)
    parts.push("--env-file", `/data/stacks/${opts.slug}.env`);
  const extra = opts.usesEnvFile ? composeDeployArgs(opts.extra) : opts.extra;
  parts.push("up", "-d", "--remove-orphans", ...extra);
  return parts.join(" ");
}
