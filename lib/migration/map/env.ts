const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

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
    if (seen.has(key))
      out[out.findIndex((e) => e.key === key)] = { key, value };
    else {
      seen.add(key);
      out.push({ key, value });
    }
  }
  return out;
}

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

export interface SharedRef {
  key: string;
  level: SharedRefLevel;
  sharedKey: string;
  whole: boolean;
}

const SHARED_REF =
  /\$?\{\{\s*(team|project|environment|server)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

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

export function envNeedsInterpolation(
  entries: { key: string; value: string }[],
): string[] {
  return entries.filter((e) => e.value.includes("${{")).map((e) => e.key);
}

function hostTokenRe(name: string): RegExp {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<=://|@)${n}(?=[:/?#]|$)|^${n}(?=:\\d)`, "gi");
}

const HOSTISH_TAIL = /(HOST|HOSTNAME|SERVER|ADDR|ADDRESS|ENDPOINT)$/i;

function isHostishKey(key: string): boolean {
  if (/^(HOST|HOSTNAME|SERVER|ADDR|ADDRESS|ENDPOINT)$/i.test(key)) return true;
  return key.includes("_") && HOSTISH_TAIL.test(key);
}

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
