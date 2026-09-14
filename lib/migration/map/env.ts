/** Deplo's env-var key grammar (`KEY_RE` in lib/data/env.ts). */
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

/**
 * Dokploy keeps env as one `.env`-shaped text column; Deplo keeps rows. Nothing
 * typed arrives: neither panel marks a variable secret, so every one lands plain.
 */
export function parseEnvBlob(blob: string | null | undefined): {
  key: string;
  value: string;
}[] {
  if (!blob) return [];
  const out: { key: string; value: string }[] = [];
  const seen = new Set<string>();
  const lines = blob.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0] === '"' || value[0] === "'" ? value[0] : "";
    if (quote && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else if (quote) {
      // A quote that does not close on its own line runs on: a private key, a
      // certificate, a service-account JSON. Read to the closing quote - and only
      // when there IS one, so a value that merely starts with one is left alone.
      const end = lines.findIndex(
        (l, j) => j > i && l.trimEnd().endsWith(quote),
      );
      if (end !== -1) {
        value = [
          value.slice(1),
          ...lines.slice(i + 1, end),
          lines[end].trimEnd().slice(0, -1),
        ].join("\n");
        i = end;
      }
    }
    // Last one wins, like a shell sourcing the file twice.
    if (seen.has(key))
      out[out.findIndex((e) => e.key === key)] = { key, value };
    else {
      seen.add(key);
      out.push({ key, value });
    }
  }
  return out;
}

/**
 * Rewrite, IN PLACE, every variable that names a database by its hostname on the
 * other platform - the app carries it inside its own connection strings. Only a
 * WHOLE host token, and only for a name specific enough (never `postgres`).
 */
export function renameDatabaseHosts(
  env: { key: string; value: string }[],
  hosts: Map<string, string>,
): string[] {
  const pairs = [...hosts]
    .filter(([from, to]) => from && to && from !== to && /[-_0-9]/.test(from))
    .sort((a, b) => b[0].length - a[0].length);
  if (pairs.length === 0) return [];
  const touched: string[] = [];
  for (const e of env) {
    let next = e.value;
    for (const [from, to] of pairs)
      next = next.replace(
        new RegExp(
          `(^|[^A-Za-z0-9._-])${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9._-])`,
          "gi",
        ),
        (_m, lead: string) => `${lead}${to}`,
      );
    if (next === e.value) continue;
    e.value = next;
    touched.push(e.key);
  }
  return touched;
}

export const SHARED_REF_LEVELS = [
  "team",
  "project",
  "environment",
  "server",
] as const;
export type SharedRefLevel = (typeof SHARED_REF_LEVELS)[number];

/** One reference a service's own value makes to a shared variable. */
export interface SharedRef {
  /** The SERVICE's own key that carried the reference. */
  key: string;
  level: SharedRefLevel;
  /** The name the shared variable has on the panel. */
  sharedKey: string;
  /** The value was EXACTLY this reference, with nothing around it. */
  whole: boolean;
}

/** The two panels differ by a dollar sign and by nothing else that matters. */
const SHARED_REF =
  /\$?\{\{\s*(team|project|environment|server)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Every shared variable these values reference, in the order they appear. */
export function sharedRefsIn(
  entries: { key: string; value: string }[],
): SharedRef[] {
  const out: SharedRef[] = [];
  for (const e of entries)
    for (const m of e.value.matchAll(SHARED_REF))
      out.push({
        key: e.key,
        level: m[1] as SharedRefLevel,
        sharedKey: m[2],
        whole: m[0] === e.value.trim(),
      });
  return out;
}

/**
 * Rewrite the references IN PLACE, like {@link renameDatabaseHosts}. A no-op on
 * Coolify, which already answers with the resolved value; on Dokploy this is
 * where a reference becomes a value, since it resolves nothing until deploy time.
 */
export function resolveSharedRefs(
  entries: { key: string; value: string }[],
  shared: Map<string, string>,
): { resolved: string[]; unresolved: string[] } {
  const resolved: string[] = [];
  const unresolved: string[] = [];
  for (const e of entries) {
    if (!e.value.includes("{{")) continue;
    let hit = false;
    let miss = false;
    e.value = e.value.replace(SHARED_REF, (whole, _level, key: string) => {
      const v = shared.get(key);
      if (v === undefined) {
        miss = true;
        return whole;
      }
      hit = true;
      return v;
    });
    if (hit) resolved.push(e.key);
    if (miss) unresolved.push(e.key);
  }
  return { resolved, unresolved };
}

/**
 * Dokploy's own template syntax for pulling a value in from the project or a
 * sibling service (`${{project.KEY}}`). Deplo resolves nothing at deploy time, so
 * such a value would reach the container literally.
 */
export function envNeedsInterpolation(
  entries: { key: string; value: string }[],
): string[] {
  return entries.filter((e) => e.value.includes("${{")).map((e) => e.key);
}

/**
 * Where a variable's VALUE names a host: after a scheme or credentials, or as
 * `<name>:<port>` on its own. Deliberately not "anywhere the word appears" -
 * `POSTGRES_DB=postgres` is a database, not a hostname.
 */
function hostTokenRe(name: string): RegExp {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<=://|@)${n}(?=[:/?#]|$)|^${n}(?=:\\d)`, "gi");
}

/** A key whose whole value is a hostname and nothing else. */
const HOSTISH_TAIL = /(HOST|HOSTNAME|SERVER|ADDR|ADDRESS|ENDPOINT)$/i;

/**
 * Whether this env key holds a HOSTNAME as its whole value. The tail alone is not
 * enough (`GHOST` is an app), nor is anchoring it to a `_`: `PAPERLESS_DBHOST`
 * glues the word onto `DB`. A separator anywhere in the key tells them apart.
 */
function isHostishKey(key: string): boolean {
  if (/^(HOST|HOSTNAME|SERVER|ADDR|ADDRESS|ENDPOINT)$/i.test(key)) return true;
  return key.includes("_") && HOSTISH_TAIL.test(key);
}

/**
 * Rewrite, IN PLACE, every value that names one of these services by its old
 * name. Returns the keys that changed.
 */
export function renameHostTokens(
  entries: { key: string; value: string }[],
  renames: Map<string, string>,
): string[] {
  if (renames.size === 0) return [];
  const touched: string[] = [];
  for (const e of entries) {
    let next = e.value;
    for (const [from, to] of renames) {
      if (isHostishKey(e.key) && next.trim().toLowerCase() === from) next = to;
      else next = next.replace(hostTokenRe(from), to);
    }
    if (next === e.value) continue;
    e.value = next;
    touched.push(e.key);
  }
  return touched;
}
