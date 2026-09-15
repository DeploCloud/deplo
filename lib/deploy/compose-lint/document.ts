import yaml, {
  isMap,
  isScalar,
  Scalar,
  visit,
  type Document,
} from "../../yaml";

// Every host-escape gate parses here and fails open on unreadable YAML: one shape gets past all of them.
export function loadComposeDoc<T>(composeYaml: string): T | null {
  try {
    return yaml.load(composeYaml) as T | null;
  } catch {
    return null;
  }
}

export interface ComposeDocShape {
  services?: Record<
    string,
    { volumes?: unknown; ports?: unknown } | null | undefined
  >;
}

export function servicesOf(
  composeYaml: string | null,
): Record<string, unknown> | null {
  if (!composeYaml || !composeYaml.trim()) return null;
  const doc = loadComposeDoc<{ services?: Record<string, unknown> }>(
    composeYaml,
  );
  const services = doc?.services;
  if (!services || typeof services !== "object" || Array.isArray(services))
    return null;
  return services;
}

// Unquoted YAML reads `022` as 22 and `1.10` as 1.1, and the container is handed a value nobody wrote.
export function keepAuthoredEnvText(doc: Document): boolean {
  let changed = false;
  visit(doc, {
    Pair(_key, pair) {
      const key = pair.key;
      if (!isScalar(key) || key.value !== "environment") return;
      if (!isMap(pair.value)) return;
      for (const item of pair.value.items) {
        const value = item.value;
        if (!isScalar(value) || typeof value.value !== "number") continue;
        if (typeof value.source !== "string") continue;
        if (value.source === String(value.value)) continue;
        value.value = value.source;
        value.type = Scalar.QUOTE_SINGLE;
        changed = true;
      }
    },
  });
  return changed;
}

// `$$` is compose's escape and interpolates nothing; `$VAR` without braces interpolates like `${VAR}`.
export function interpolates(value: string): boolean {
  return /(^|[^$])\$(\$\$)*[^$]/.test(`${value.trim()} `);
}

export function isInterpolated(v: unknown): boolean {
  return typeof v === "string" && interpolates(v);
}

// Compose casts to a typed bool, so `privileged: yes` reached the host past a gate testing `=== true`.
export function composeTruthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  return typeof v === "string" && /^(y|yes|true|on|1)$/i.test(v.trim());
}

export function composeHasInlineEnvValues(composeYaml: string): boolean {
  const doc = loadComposeDoc<ComposeDocShape>(composeYaml);
  for (const svc of Object.values(doc?.services ?? {})) {
    const env = (svc as { environment?: unknown } | null)?.environment;
    if (Array.isArray(env)) {
      if (env.some((e) => typeof e === "string" && e.includes("=")))
        return true;
    } else if (env && typeof env === "object") {
      if (
        Object.values(env as Record<string, unknown>).some(
          (v) => v != null && String(v) !== "",
        )
      )
        return true;
    }
  }
  return false;
}

export const MAX_COMPOSE_BYTES = 256 * 1024;
const MAX_COMPOSE_NODES = 20_000;

const tooManyEntries = () =>
  new Error(
    "The compose file expands to too many entries - unroll its YAML anchors.",
  );

// A few nested YAML aliases turn 400 bytes into gigabytes when the renderer dumps them resolved.
export function assertComposeWithinLimits(composeYaml: string): void {
  if (Buffer.byteLength(composeYaml, "utf8") > MAX_COMPOSE_BYTES)
    throw new Error("The compose file is too large (256 KiB max).");
  let doc: unknown;
  try {
    doc = yaml.load(composeYaml);
  } catch (e) {
    if (/alias count/i.test(String(e))) throw tooManyEntries();
    return;
  }
  let nodes = 0;
  const walk = (v: unknown): void => {
    if (++nodes > MAX_COMPOSE_NODES) throw tooManyEntries();
    if (Array.isArray(v)) for (const x of v) walk(x);
    else if (v && typeof v === "object")
      for (const x of Object.values(v as Record<string, unknown>)) walk(x);
  };
  walk(doc);
}
