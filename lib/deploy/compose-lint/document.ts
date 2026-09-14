import yaml, {
  isMap,
  isScalar,
  Scalar,
  visit,
  type Document,
} from "../../yaml";

// Parse a compose file, or null when it does not parse.
export function loadComposeDoc<T>(composeYaml: string): T | null {
  try {
    return yaml.load(composeYaml) as T | null;
  } catch {
    return null;
  }
}

// The slice of a compose document the volume / port readers look at.
export interface ComposeDocShape {
  services?: Record<
    string,
    { volumes?: unknown; ports?: unknown } | null | undefined
  >;
}

// The services map of a compose file, or null when there isn't one.
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

// An `environment:` value is TEXT by the time the container reads it: `UMASK: 022`
// parses to 22 and comes back `22`. Only `environment` - elsewhere quoting a number
// would change what compose reads.
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

// Whether compose would substitute something into this value. `$$` is its escape,
// so `$$HOME` interpolates nothing while `$HOME` and `${HOME}` both do.
export function interpolates(value: string): boolean {
  return /(^|[^$])\$(\$\$)*[^$]/.test(`${value.trim()} `);
}

// The same question for a value of any type: only a string can interpolate.
export function isInterpolated(v: unknown): boolean {
  return typeof v === "string" && interpolates(v);
}

// Whether compose would read this value as TRUE. It casts to a typed bool, so the
// YAML 1.1 spellings (`yes`, `on`, `y`) and a quoted `"true"` count - which is how
// `privileged: yes` reached the host past a gate testing `=== true`.
export function composeTruthy(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  return typeof v === "string" && /^(y|yes|true|on|1)$/i.test(v.trim());
}

// Whether any service carries an `environment:` VALUE inline - `KEY=value` in the
// list form, or a non-empty value in the map form. A bare `KEY` is not a value.
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

// The most compose text an app may carry, and the most nodes it may expand to.
export const MAX_COMPOSE_BYTES = 256 * 1024;
const MAX_COMPOSE_NODES = 20_000;

const tooManyEntries = () =>
  new Error(
    "The compose file expands to too many entries - unroll its YAML anchors.",
  );

// Refuse a compose file too big to keep, or that expands past reason: a few nested
// YAML aliases turn 400 bytes into gigabytes when the renderer dumps the document
// with every alias resolved, and that dump runs on the event loop.
export function assertComposeWithinLimits(composeYaml: string): void {
  if (Buffer.byteLength(composeYaml, "utf8") > MAX_COMPOSE_BYTES)
    throw new Error("The compose file is too large (256 KiB max).");
  let doc: unknown;
  try {
    doc = yaml.load(composeYaml);
  } catch (e) {
    if (/alias count/i.test(String(e))) throw tooManyEntries();
    return; // unparseable never expands; the linter says why it is wrong
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
