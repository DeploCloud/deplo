import "server-only";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Loads a one-click template's deployable blueprint from
 * `templates/blueprints/<id>/`: the docker-compose.yml and the default
 * environment variables declared in template.toml `[variables]`. These are
 * shown in the deploy wizard so the user can edit the compose file and settings
 * before deploying, not just pick a server.
 */

const BLUEPRINTS_DIR = join(process.cwd(), "templates", "blueprints");

export interface BlueprintEnv {
  key: string;
  value: string;
}

export interface TemplateBlueprint {
  compose: string;
  env: BlueprintEnv[];
}

/** Strict id check so a template id can never escape the blueprints directory. */
function isSafeId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/i.test(id) && !id.includes("..");
}

function randomSecret(len: number): string {
  return randomBytes(Math.ceil(len)).toString("base64url").slice(0, len);
}

/** Parse the `[variables]` table of a template.toml into key/value pairs. */
function parseVariables(toml: string): BlueprintEnv[] {
  const lines = toml.split(/\r?\n/);
  const raw: BlueprintEnv[] = [];
  let inVars = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inVars = trimmed === "[variables]";
      continue;
    }
    if (!inVars || !trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) raw.push({ key, value });
  }
  return resolveVariables(raw);
}

/**
 * Resolve template tokens: `${password:N}` becomes a random secret, `${domain}`
 * is left for the user to fill, and `${OTHER_VAR}` references are substituted.
 */
function resolveVariables(raw: BlueprintEnv[]): BlueprintEnv[] {
  const resolved: Record<string, string> = {};
  // First pass: generators and literals.
  for (const { key, value } of raw) {
    const pw = value.match(/^\$\{password:(\d+)\}$/);
    if (pw) {
      resolved[key] = randomSecret(Number(pw[1]));
    } else if (value === "${domain}") {
      resolved[key] = "";
    } else {
      resolved[key] = value;
    }
  }
  // Second pass: substitute ${VAR} references to already-resolved variables.
  for (const key of Object.keys(resolved)) {
    resolved[key] = resolved[key].replace(/\$\{(\w+)\}/g, (m, ref) =>
      ref in resolved ? resolved[ref] : m
    );
  }
  return raw.map(({ key }) => ({ key, value: resolved[key] }));
}

export function getTemplateBlueprint(id: string): TemplateBlueprint | null {
  if (!isSafeId(id)) return null;
  const dir = join(BLUEPRINTS_DIR, id);
  const composePath = join(dir, "docker-compose.yml");
  if (!existsSync(composePath)) return null;

  const compose = readFileSync(composePath, "utf8");

  let env: BlueprintEnv[] = [];
  const tomlPath = join(dir, "template.toml");
  if (existsSync(tomlPath)) {
    try {
      env = parseVariables(readFileSync(tomlPath, "utf8"));
    } catch {
      env = [];
    }
  }
  return { compose, env };
}
