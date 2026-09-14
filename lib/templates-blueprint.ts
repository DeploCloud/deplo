import "server-only";

import { randomBytes, randomUUID } from "node:crypto";

export interface BlueprintEnv {
  key: string;
  value: string;
}

export interface BlueprintExpose {
  service: string;
  port: number;
  host?: string;
  path?: string;
}

export interface BlueprintMount {
  filePath: string;
  content: string;
}

export interface TemplateBlueprint {
  compose: string;
  env: BlueprintEnv[];
  expose: BlueprintExpose | null;
  exposes: BlueprintExpose[];
  mounts: BlueprintMount[];
}

function randomSecret(len: number): string {
  return randomBytes(Math.ceil(len)).toString("base64url").slice(0, len);
}

function randomHex(len: number): string {
  return randomBytes(Math.ceil(len / 2))
    .toString("hex")
    .slice(0, len);
}

// Helpers MUST produce fresh random secrets, so deployed stacks never share predictable credentials across installs.
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

// TOML integers allow `_` digit separators (e.g. 5_006).
function parseTomlInt(value: string): number {
  return Number(stripQuotes(value).replace(/_/g, ""));
}

function parseTomlBool(value: string): boolean {
  return stripQuotes(value).toLowerCase() === "true";
}

interface ParsedToml {
  variables: BlueprintEnv[];
  configEnv: BlueprintEnv[];
  domains: {
    serviceName: string;
    port: number;
    host: string;
    path: string;
    primary: boolean;
  }[];
  mounts: BlueprintMount[];
}

function parseToml(toml: string): ParsedToml {
  const variables: BlueprintEnv[] = [];
  const configEnv: BlueprintEnv[] = [];
  const domains: {
    serviceName: string;
    port: number;
    host: string;
    path: string;
    primary: boolean;
  }[] = [];
  const mounts: BlueprintMount[] = [];

  const lines = toml.split(/\r?\n/);
  let section = "";
  let envArrayOpen = false;
  let tripleOpen = false;
  let tripleBuf: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();

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
        domains.push({
          serviceName: "",
          port: 0,
          host: "",
          path: "",
          primary: false,
        });
      } else if (section === "[[config.mounts]]") {
        mounts.push({ filePath: "", content: "" });
      }
      continue;
    }

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

    if (
      section === "[[config.mounts]]" &&
      key === "content" &&
      rhs.startsWith('"""')
    ) {
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
      else if (key === "path") cur.path = value;
      else if (key === "primary") cur.primary = parseTomlBool(value);
    } else if (section === "[[config.mounts]]") {
      const cur = mounts[mounts.length - 1];
      if (cur && key === "filePath") cur.filePath = value;
    }
  }

  return { variables, configEnv, domains, mounts };
}

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
  list.push({
    key: entry.slice(0, eq).trim(),
    value: entry.slice(eq + 1).trim(),
  });
}

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
        resolved[key] = gen ?? value;
      }
    } else {
      resolved[key] = value;
    }
  }
  // Two passes cover one level of nesting.
  for (let pass = 0; pass < 2; pass++) {
    for (const key of Object.keys(resolved)) {
      resolved[key] = substituteRefs(resolved[key], resolved, domain);
    }
  }
  return resolved;
}

function substituteRefs(
  input: string,
  vars: Record<string, string>,
  domain: string,
): string {
  return input.replace(
    /\$\{([a-zA-Z0-9_]+)(?::([0-9_]+))?\}/g,
    (m, name, len) => {
      if (name === "domain") return domain;
      if (name in vars) return vars[name];
      const gen = generateHelper(name, len);
      return gen ?? m;
    },
  );
}

export function getTemplateBlueprint(
  template: { slug: string; compose: string; config: string },
  opts: { domain?: string } = {},
): TemplateBlueprint {
  const compose = template.compose;
  const domain = opts.domain ?? "";

  let env: BlueprintEnv[] = [];
  let expose: BlueprintExpose | null = null;
  let exposes: BlueprintExpose[] = [];
  let mounts: BlueprintMount[] = [];

  if (template.config) {
    try {
      const parsed = parseToml(template.config);
      const vars = resolveVariables(parsed.variables, domain);

      const source = parsed.configEnv.length
        ? parsed.configEnv
        : parsed.variables;
      env = source.map(({ key, value }) => ({
        key,
        value: substituteRefs(value, vars, domain),
      }));

      // The primary is moved first because creation treats the first expose as the service behind the main domain.
      const domains = parsed.domains.filter((d) => d.serviceName && d.port);
      const primary = domains.find((d) => d.primary);
      const orderedDomains = primary
        ? [primary, ...domains.filter((d) => d !== primary)]
        : domains;
      exposes = orderedDomains.map((d) => ({
        service: d.serviceName,
        port: d.port,
        host: d.host ? substituteRefs(d.host, vars, domain) : undefined,
        ...(d.path ? { path: d.path } : {}),
      }));
      expose = exposes[0] ?? null;

      mounts = parsed.mounts
        .filter((mt) => mt.filePath)
        .map((mt) => ({
          filePath: mt.filePath,
          content: substituteRefs(mt.content, vars, domain),
        }));

      warnUnresolved(template.slug, env, mounts);
    } catch {
      env = [];
      exposes = [];
      mounts = [];
    }
  }

  return { compose, env, expose, exposes, mounts };
}

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
