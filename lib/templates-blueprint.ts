import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

/**
 * Loads a one-click template's deployable blueprint from
 * `templates/blueprints/<id>/`: the docker-compose.yml plus the template.toml
 * that declares its variables, the environment it injects, which service is
 * exposed publicly, and any config files to mount into the stack. This is the
 * Dokploy/Coolify template format:
 *
 *   [variables]            # ${password:N} / ${base64:N} / ${domain} / ${REF} ...
 *   [config]
 *   env = ["NAME=${var}"]  # (array form) OR
 *   [config.env]           # (table form) NAME = "${var}"
 *   [[config.domains]]     # which service Traefik exposes
 *   serviceName = "app"
 *   port = 3000
 *   host = "${domain}"
 *   [[config.mounts]]      # files written next to the stack and bind-mounted
 *   filePath = "configuration.yml"
 *   content = """ ... """
 *
 * Everything is resolved here so the deploy wizard shows the real, editable
 * compose + env, the deploy engine can wire the stack to Traefik on the
 * generated domain, and any required config files are materialised with the
 * SAME generated secrets the env uses.
 */

const BLUEPRINTS_DIR = join(process.cwd(), "templates", "blueprints");

export interface BlueprintEnv {
  key: string;
  value: string;
}

export interface BlueprintExpose {
  service: string;
  port: number;
  /** Resolved public hostname this service is routed on (from config.domains). */
  host?: string;
}

export interface BlueprintMount {
  filePath: string;
  content: string;
}

export interface TemplateBlueprint {
  compose: string;
  /** Environment variables the compose interpolates (config.env, resolved). */
  env: BlueprintEnv[];
  /** Which service + container port Traefik should route to (first domain). */
  expose: BlueprintExpose | null;
  /**
   * Every service the template exposes publicly (one per config.domains entry),
   * each on its own resolved hostname. Templates like garage-with-ui expose two
   * (the API and the web UI); `expose` is just the first of these.
   */
  exposes: BlueprintExpose[];
  /** Config files to write next to the stack and bind-mount (resolved). */
  mounts: BlueprintMount[];
}

/** Strict id check so a template id can never escape the blueprints directory. */
function isSafeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes("..");
}

function randomSecret(len: number): string {
  return randomBytes(Math.ceil(len)).toString("base64url").slice(0, len);
}

function randomHex(len: number): string {
  return randomBytes(Math.ceil(len / 2)).toString("hex").slice(0, len);
}

/**
 * Generate a value for a Dokploy template helper token. Returns null when the
 * token is not a generator (then it is treated as a ${REF} to another variable).
 * Helpers MUST produce fresh random secrets so deployed stacks never share
 * predictable credentials across installs.
 */
function generateHelper(name: string, lenRaw?: string): string | null {
  const len = lenRaw ? Number(lenRaw.replace(/_/g, "")) : undefined;
  switch (name) {
    case "password":
    case "secret":
    case "jwt":
    case "base64":
      return randomSecret(len ?? 32);
    case "hash":
      return randomHex(len ?? 64);
    case "uuid":
      return randomUUID();
    case "username":
      return "admin";
    case "email":
      return `admin@example.com`;
    case "timezone":
    case "tz":
      return "UTC";
    default:
      return null;
  }
}

const HELPER_TOKEN = /^\$\{([a-zA-Z0-9_]+)(?::([0-9_]+))?\}$/;

function stripQuotes(value: string): string {
  const v = value.trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Drop a trailing `# comment` from a TOML scalar/array entry, ignoring any `#`
 * that sits inside a quoted string (so `KEY = "a#b"` and URLs keep their hash).
 * Returns the text up to the first unquoted `#`, trimmed.
 */
function stripComment(input: string): string {
  let q: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (q) {
      if (ch === q) q = null;
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (ch === "#") {
      return input.slice(0, i).trim();
    }
  }
  return input.trim();
}

/** TOML integers allow `_` digit separators (e.g. 5_006). */
function parseTomlInt(value: string): number {
  return Number(stripQuotes(value).replace(/_/g, ""));
}

interface ParsedToml {
  variables: BlueprintEnv[];
  configEnv: BlueprintEnv[];
  domains: { serviceName: string; port: number; host: string }[];
  mounts: BlueprintMount[];
}

/**
 * Minimal, purpose-built reader for the subset of TOML these templates use:
 * `[variables]`, `[config]` (with an inline multi-line `env = [...]` array),
 * `[config.env]` table, `[[config.domains]]` array-of-tables and
 * `[[config.mounts]]` array-of-tables (whose `content` is a `"""..."""` block).
 */
function parseToml(toml: string): ParsedToml {
  const variables: BlueprintEnv[] = [];
  const configEnv: BlueprintEnv[] = [];
  const domains: { serviceName: string; port: number; host: string }[] = [];
  const mounts: BlueprintMount[] = [];

  const lines = toml.split(/\r?\n/);
  let section = "";
  let envArrayOpen = false;
  let tripleOpen = false;
  let tripleBuf: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

    // Capture a multi-line triple-quoted mount `content`.
    if (tripleOpen) {
      const endIdx = raw.indexOf('"""');
      if (endIdx !== -1) {
        tripleBuf.push(raw.slice(0, endIdx));
        const cur = mounts[mounts.length - 1];
        if (cur) cur.content = tripleBuf.join("\n");
        tripleOpen = false;
        tripleBuf = [];
      } else {
        tripleBuf.push(raw);
      }
      continue;
    }

    // Collect entries of an open inline `env = [ ... ]` array. Skip whole-line
    // comments and blank padding entries the template author left for humans.
    if (envArrayOpen) {
      if (line.includes("]")) envArrayOpen = false;
      const raw = line.replace(/[\],]+$/g, "").trim();
      const entry = stripQuotes(raw);
      if (entry && !entry.startsWith("#")) pushKeyValEntry(configEnv, entry);
      continue;
    }

    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("[")) {
      section = line.replace(/\s+#.*$/, "");
      if (section === "[[config.domains]]") {
        domains.push({ serviceName: "", port: 0, host: "" });
      } else if (section === "[[config.mounts]]") {
        mounts.push({ filePath: "", content: "" });
      }
      continue;
    }

    // `env = [` opens the array form of config env.
    const arrayStart = line.match(/^env\s*=\s*\[(.*)$/);
    if (section === "[config]" && arrayStart) {
      const inline = arrayStart[1];
      if (!inline.includes("]")) envArrayOpen = true;
      const body = inline.replace(/\].*$/, "");
      for (const part of splitTopLevel(body)) {
        const entry = stripQuotes(part.trim());
        if (entry && !entry.startsWith("#")) pushKeyValEntry(configEnv, entry);
      }
      continue;
    }

    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const rhs = line.slice(eq + 1).trim();

    // A `content = """` that opens a triple-quoted block on this line.
    if (section === "[[config.mounts]]" && key === "content" && rhs.startsWith('"""')) {
      const after = rhs.slice(3);
      const endIdx = after.indexOf('"""');
      const cur = mounts[mounts.length - 1];
      if (endIdx !== -1) {
        if (cur) cur.content = after.slice(0, endIdx);
      } else {
        tripleOpen = true;
        tripleBuf = after ? [after] : [];
      }
      continue;
    }

    // Single-line scalar: drop any trailing `# comment` (the multi-line mount
    // `content = """..."""` case is handled above and never reaches here).
    const value = stripQuotes(stripComment(rhs));
    if (section === "[variables]") {
      variables.push({ key, value });
    } else if (section === "[config.env]") {
      configEnv.push({ key, value });
    } else if (section === "[[config.domains]]") {
      const cur = domains[domains.length - 1];
      if (!cur) continue;
      if (key === "serviceName") cur.serviceName = value;
      else if (key === "port") cur.port = parseTomlInt(value);
      else if (key === "host") cur.host = value;
    } else if (section === "[[config.mounts]]") {
      const cur = mounts[mounts.length - 1];
      if (cur && key === "filePath") cur.filePath = value;
    }
  }

  return { variables, configEnv, domains, mounts };
}

/** Split a comma-separated array body, ignoring commas inside quotes. */
function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: string | null = null;
  for (const ch of body) {
    if (q) {
      if (ch === q) q = null;
      cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function pushKeyValEntry(list: BlueprintEnv[], entry: string): void {
  const eq = entry.indexOf("=");
  if (eq === -1) return;
  list.push({ key: entry.slice(0, eq).trim(), value: entry.slice(eq + 1).trim() });
}

/**
 * Resolve template tokens to a flat variable map. `${password:N}` and the other
 * generator helpers become fresh random secrets, `${domain}` becomes the
 * supplied generated hostname, and `${OTHER_VAR}` references are substituted
 * from already-resolved variables. Generated once here so every consumer (env,
 * mounts) shares the same values.
 */
function resolveVariables(
  raw: BlueprintEnv[],
  domain: string,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const { key, value } of raw) {
    const m = value.match(HELPER_TOKEN);
    if (m) {
      if (m[1] === "domain") resolved[key] = domain;
      else {
        const gen = generateHelper(m[1], m[2]);
        resolved[key] = gen ?? value; // unknown single-token ref: resolve below
      }
    } else {
      resolved[key] = value;
    }
  }
  // Substitute ${REF} references (two passes cover one level of nesting).
  for (let pass = 0; pass < 2; pass++) {
    for (const key of Object.keys(resolved)) {
      resolved[key] = substituteRefs(resolved[key], resolved, domain);
    }
  }
  return resolved;
}

/**
 * Replace ${...} tokens in a string: ${domain} -> domain, a known generator
 * helper -> a fresh secret, a reference to a resolved variable -> its value.
 * Unknown tokens are left intact (and flagged by the caller) so a literal token
 * is never silently baked into a secret without notice.
 */
function substituteRefs(
  input: string,
  vars: Record<string, string>,
  domain: string,
): string {
  return input.replace(/\$\{([a-zA-Z0-9_]+)(?::([0-9_]+))?\}/g, (m, name, len) => {
    if (name === "domain") return domain;
    if (name in vars) return vars[name];
    const gen = generateHelper(name, len);
    return gen ?? m;
  });
}

export function getTemplateBlueprint(
  id: string,
  opts: { domain?: string } = {},
): TemplateBlueprint | null {
  if (!isSafeId(id)) return null;
  const dir = join(BLUEPRINTS_DIR, id);
  const composePath = join(dir, "docker-compose.yml");
  if (!existsSync(composePath)) return null;

  const compose = readFileSync(composePath, "utf8");
  const domain = opts.domain ?? "";

  let env: BlueprintEnv[] = [];
  let expose: BlueprintExpose | null = null;
  let exposes: BlueprintExpose[] = [];
  let mounts: BlueprintMount[] = [];

  const tomlPath = join(dir, "template.toml");
  if (existsSync(tomlPath)) {
    try {
      const parsed = parseToml(readFileSync(tomlPath, "utf8"));
      const vars = resolveVariables(parsed.variables, domain);

      const source = parsed.configEnv.length ? parsed.configEnv : parsed.variables;
      env = source.map(({ key, value }) => ({
        key,
        value: substituteRefs(value, vars, domain),
      }));

      // One expose per declared domain, each on its own resolved hostname. The
      // host pattern (e.g. `web-ui.${domain}`) is resolved against the template
      // variables so secondary services get the subdomain the author intended.
      exposes = parsed.domains
        .filter((d) => d.serviceName && d.port)
        .map((d) => ({
          service: d.serviceName,
          port: d.port,
          host: d.host ? substituteRefs(d.host, vars, domain) : undefined,
        }));
      expose = exposes[0] ?? null;

      mounts = parsed.mounts
        .filter((mt) => mt.filePath)
        .map((mt) => ({
          filePath: mt.filePath,
          content: substituteRefs(mt.content, vars, domain),
        }));

      warnUnresolved(id, env, mounts);
    } catch {
      env = [];
      exposes = [];
      mounts = [];
    }
  }

  return { compose, env, expose, exposes, mounts };
}

/** Surface any token a template references that we could not resolve. */
function warnUnresolved(
  id: string,
  env: BlueprintEnv[],
  mounts: BlueprintMount[],
): void {
  const leftover = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(/\$\{[a-zA-Z0-9_:]+\}/g)) leftover.add(m[0]);
  };
  for (const e of env) scan(e.value);
  for (const mt of mounts) scan(mt.content);
  if (leftover.size) {
    console.warn(
      `[deplo] template ${id}: unresolved tokens ${[...leftover].join(", ")}`,
    );
  }
}
