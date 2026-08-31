// https://deplo.build/docs/guides/move-from-dokploy

/**
 * Dokploy row → deplo input. The convention for anything that cannot be
 * represented: return the value that IS representable and add a line to `notes`.
 */

import yaml, {
  isMap,
  isScalar,
  isSeq,
  Scalar,
  type Document,
  type YAMLMap,
} from "../yaml";

import { isValidLogoValue } from "../apps/logo-shared";
import { composeRoutePort, keepAuthoredEnvText } from "../deploy/compose-lint";
import { HEALTH_CHECK_DEFAULTS } from "../deploy/health-check";

import type {
  BuildConfig,
  BuildMethod,
  CertProvider,
  DatabaseType,
  DomainEntrypoint,
  GitRepo,
  HealthCheck,
  ResourceLimits,
  VolumeMount,
} from "../types";
import type {
  HostMount,
  NamedVolume,
  SourceApplication,
  SourceCompose,
  SourceDatabase,
  SourceDbKind,
  SourceDomain,
  SourceMount,
} from "./model";

/** Same shape as `ResourceLimitsInput` in lib/data/apps.ts, without importing a
 *  `server-only` module into a file that must stay client-safe. */
export type ResourceInput = {
  [K in keyof ResourceLimits]?: ResourceLimits[K] | null;
};

/** What a mapper produces: the deplo input plus what could not come across. */
export interface Mapped<T> {
  value: T;
  notes: string[];
}

/** deplo's env-var key grammar (`KEY_RE` in lib/data/env.ts). */
const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

/* ------------------------------------------------------------------ */
/* Env blobs                                                           */
/* ------------------------------------------------------------------ */

/**
 * A variable whose NAME says it holds a credential.
 *
 * Read on the name alone - the value of a secret looks like the value of
 * anything else. Everything migrated used to arrive `plain`, which left a whole
 * panel's passwords readable at the `view` floor and let them ride into the
 * preview of a fork (that filter discriminates on the type and nothing else).
 */
const SECRET_WORDS = new Set([
  "PASSWORD",
  "PASSWORDS",
  "PASSWD",
  "PASS",
  "PWD",
  "SECRET",
  "SECRETS",
  "TOKEN",
  "TOKENS",
  "KEY",
  "KEYS",
  "APIKEY",
  "CREDENTIAL",
  "CREDENTIALS",
  "PASSPHRASE",
  "SALT",
  "PRIVATE",
  "SIGNING",
  "SIGNATURE",
  "HMAC",
  "SEED",
  // The abbreviations, which are how half of them are actually spelled: a Stripe
  // secret key is `STRIPE_SK`, never `STRIPE_SECRET_KEY`. `PK` is deliberately
  // absent - it is the publishable half as often as it is a private key.
  "SK",
  "PSK",
  "PAT",
]);

/** Words that say the value is the PUBLIC half, whatever else the name says. */
const PUBLIC_WORDS = new Set(["PUBLIC", "PUB", "PUBLISHABLE"]);

/**
 * Words that name an ADDRESS. One is a credential only when the address it holds
 * carries one - on the name alone, `DB_CONNECTION=pgsql` (a driver) and every
 * `SERVICE_URL_*` (a public address) landed write-only with no way back.
 */
const ADDRESS_WORDS = new Set([
  "URL",
  "URI",
  "DSN",
  "CONNECTION",
  "CONNECTIONSTRING",
  "WEBHOOK",
]);

/** 16+ characters of one opaque run: the shape a token has in a path or a query. */
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{16,}$/;

/**
 * Whether a URL carries its own credential: any userinfo (`k@`, `u:p@`), a query
 * parameter that names one, or a path segment long and opaque enough to be a
 * token - a Slack webhook is nothing but that segment.
 */
export function urlCarriesCredential(value: string): boolean {
  const v = value.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+@/i.test(v)) return true;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return false;
  }
  for (const [name, val] of url.searchParams)
    if (looksLikeSecretKey(name) || OPAQUE_TOKEN.test(val)) return true;
  return url.pathname.split("/").some((seg) => OPAQUE_TOKEN.test(seg));
}

/**
 * A value that carries a credential whatever its name says: a URL with a
 * `user:pass@`, or a PEM private key. The name heuristic can only ever cover the
 * names people happen to use; this covers the rest.
 */
const CREDENTIAL_VALUE =
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@|-----BEGIN [A-Z ]*PRIVATE KEY-----/i;

export function looksLikeSecretKey(key: string): boolean {
  const parts = key
    .toUpperCase()
    .split(/[_\-.]/)
    .filter(Boolean);
  if (parts.some((p) => PUBLIC_WORDS.has(p))) return false;
  return parts.some((p) => SECRET_WORDS.has(p));
}

/** The type a migrated variable lands with - on its name, or on a value that is
 *  self-evidently a credential. */
export function migratedEnvType(
  key: string,
  value?: string,
): "plain" | "secret" {
  if (looksLikeSecretKey(key)) return "secret";
  const v = value?.trim() ?? "";
  if (v && CREDENTIAL_VALUE.test(v)) return "secret";
  // An address is judged by what it holds, not by being called one.
  return namesAnAddress(key) && urlCarriesCredential(v) ? "secret" : "plain";
}

/** Whether the NAME says this variable holds an address. */
function namesAnAddress(key: string): boolean {
  return key
    .toUpperCase()
    .split(/[_\-.]/)
    .some((p) => ADDRESS_WORDS.has(p));
}

/**
 * Dokploy keeps env as one `.env`-shaped text column; deplo keeps rows.
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
 * Rewrite, IN PLACE, every variable that names a database by the hostname it had
 * on the other platform. The renamed host is the first thing that breaks after a
 * migration, and the app carries it inside its own connection strings.
 *
 * Only a WHOLE host token is replaced, and only for a name specific enough to be
 * one: a database called `postgres` would otherwise turn `DB_ENGINE=postgres`
 * into a hostname. Returns the keys that changed.
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

/* ------------------------------------------------------------------ */
/* Shared-variable references (`{{team.KEY}}` / `${{project.KEY}}`)     */
/* ------------------------------------------------------------------ */

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
 * sibling service (`${{project.KEY}}`). deplo resolves nothing at deploy time, so
 * such a value would reach the container literally.
 */
export function envNeedsInterpolation(
  entries: { key: string; value: string }[],
): string[] {
  return entries.filter((e) => e.value.includes("${{")).map((e) => e.key);
}

/* ------------------------------------------------------------------ */
/* Compose: drop the source platform's shared network                  */
/* ------------------------------------------------------------------ */

const DOKPLOY_NETWORK = "dokploy-network";

/**
 * The maps a compose file writes a SERVICE's keys into: the services themselves,
 * and the top-level `x-*` blocks the services merge from. An anchor is where the
 * value really lives, so a rewrite that skips it edits a copy.
 */
function serviceLikeMaps(root: YAMLMap): { name: string; map: YAMLMap }[] {
  const out: { name: string; map: YAMLMap }[] = [];
  const services = root.get("services");
  if (isMap(services))
    for (const item of services.items)
      if (isMap(item.value))
        out.push({
          name: String((item.key as Scalar).value),
          map: item.value,
        });
  for (const item of root.items) {
    const name = String((item.key as Scalar | null)?.value ?? "");
    if (name.startsWith("x-") && isMap(item.value))
      out.push({ name, map: item.value });
  }
  return out;
}

/** The Scalar node at `map[key]`, when it holds a string. Its `value` is editable
 *  in place, which is what keeps the rest of the file exactly as it was written. */
function stringScalar(map: YAMLMap, key: string): Scalar | null {
  const node = map.get(key, true);
  return isScalar(node) && typeof node.value === "string" ? node : null;
}

/**
 * The source platform whose compose this is: the name a report says, and the
 * networks that belong to the platform rather than to the stack.
 */
export interface SourcePlatformShape {
  name: string;
  networks: readonly string[];
}

/**
 * A note written by a mapper says `{panel}` where the source product's name goes.
 * The mappers do not know which panel they are reading, and a report that told a
 * Coolify user what happened "on Dokploy" would simply be wrong.
 */
export function withPanel(text: string, panel: string): string {
  return text.split("{panel}").join(panel);
}

export const DOKPLOY_PLATFORM: SourcePlatformShape = {
  name: "Dokploy",
  networks: [DOKPLOY_NETWORK],
};

/**
 * Every top-level network KEY in this compose that resolves to one of the
 * platform's own networks - which is not only the key that spells its name.
 */
export function platformNetworkKeys(
  doc: { networks?: unknown },
  names: readonly string[],
): Set<string> {
  const keys = new Set<string>();
  const wanted = new Set(names.map((n) => n.trim()).filter(Boolean));
  const declared = doc.networks;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return keys;
  for (const [key, raw] of Object.entries(
    declared as Record<string, unknown>,
  )) {
    // Dokploy's fixed name speaks for itself. Any other name has to say
    // `external:` or point with `name:`: an internal network someone happened to
    // call `coolify` is theirs, not the platform's.
    if (key === DOKPLOY_NETWORK && wanted.has(key)) keys.add(key);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const n = raw as Record<string, unknown>;
    const ext = n.external;
    const extName =
      ext != null && typeof ext === "object" && !Array.isArray(ext)
        ? (ext as Record<string, unknown>).name
        : null;
    const named =
      (typeof n.name === "string" && wanted.has(n.name.trim())) ||
      (typeof extName === "string" && wanted.has(extName.trim()));
    if (named || (wanted.has(key) && ext === true)) keys.add(key);
  }
  return keys;
}

/** Take those networks off one `networks:` value, in either of its two shapes. */
function stripNetworks(holder: YAMLMap, keys: Set<string>): void {
  const node = holder.get("networks", true);
  if (isSeq(node)) {
    node.items = node.items.filter(
      (entry) => !keys.has(String(isScalar(entry) ? entry.value : entry)),
    );
    if (node.items.length === 0) holder.delete("networks");
  } else if (isMap(node)) {
    for (const key of keys) node.delete(key);
    if (node.items.length === 0) holder.delete("networks");
  }
}

/**
 * Turn the source platform's compose file into a Deplo one. Left alone, a `../`
 * source is not
 * merely wrong - Deplo reads it as climbing OUT of the sandbox, so the stack would
 * demand the host-volumes grant and then bind a path that holds nothing.
 *
 * Edited as a DOCUMENT, so anchors, merge keys, comments and layout come out the
 * way their author wrote them - and an anchor is edited once, for every service
 * that merges it.
 */
export function adaptComposeForDeplo(
  source: string,
  platform: SourcePlatformShape = DOKPLOY_PLATFORM,
): {
  compose: string;
  changes: string[];
} {
  const doc = readComposeDoc(source);
  if (!doc) return { compose: source, changes: [] };
  const root = doc.contents as YAMLMap;

  const changes: string[] = [];
  const keys = platformNetworkKeys(
    { networks: toPlain(root.get("networks")) },
    platform.networks,
  );

  if (keys.size > 0) {
    const declared = root.get("networks", true);
    if (isMap(declared)) {
      for (const key of keys) declared.delete(key);
      if (declared.items.length === 0) root.delete("networks");
    }
    changes.push(
      `${platform.name}'s shared network was removed - Deplo attaches the services to its own.`,
    );
  }

  // Every named volume a service mounts, so an undeclared one can be declared
  // below rather than refused by `docker compose up`.
  const mounted = new Set<string>();

  for (const { map: holder } of serviceLikeMaps(root)) {
    if (keys.size > 0) stripNetworks(holder, keys);

    // The file-mount paths, off both shapes of a volume entry. A SEQUENCE is what
    // tells a service's mounts from the top-level named-volume block.
    const vols = holder.get("volumes", true);
    if (!isSeq(vols)) continue;
    for (const entry of vols.items) {
      if (isScalar(entry) && typeof entry.value === "string") {
        const spec: string = entry.value;
        const idx = spec.indexOf(":");
        if (idx <= 0) continue;
        let source = spec.slice(0, idx);
        const rest = spec.slice(idx);

        const trimmed = trailingSlashOffVolume(source);
        if (trimmed) {
          changes.push(
            `${source} is a volume name with a slash on the end, which compose refuses - it is ${trimmed} here.`,
          );
          source = trimmed;
          entry.value = `${source}${rest}`;
        }
        if (isNamedVolumeSource(source)) mounted.add(source.trim());
        const rewritten = deploFilesPath(source);
        if (rewritten == null) continue;
        changes.push(`${source} now points at Deplo's files directory.`);
        entry.value = `${rewritten}${rest}`;
      } else if (isMap(entry)) {
        const src = stringScalar(entry, "source");
        if (!src) continue;
        const trimmed = trailingSlashOffVolume(src.value as string);
        if (trimmed) {
          changes.push(
            `${src.value} is a volume name with a slash on the end, which compose refuses - it is ${trimmed} here.`,
          );
          src.value = trimmed;
        }
        const type = stringScalar(entry, "type")?.value;
        if (
          (type === "volume" || type == null) &&
          isNamedVolumeSource(src.value as string)
        )
          mounted.add((src.value as string).trim());
        const rewritten = deploFilesPath(src.value as string);
        if (rewritten == null) continue;
        changes.push(`${src.value} now points at Deplo's files directory.`);
        src.value = rewritten;
      }
    }
  }

  declareMissingVolumes(doc, root, mounted, changes);

  // The SAME `../files/x` rewrite, everywhere else a compose file can name a file
  // next to itself.
  for (const [where, target] of composeFileRefs(root)) {
    const rewritten = deploFilesPath(target.value as string);
    if (rewritten == null) continue;
    changes.push(
      `${target.value} now points at Deplo's files directory (${where}).`,
    );
    target.value = rewritten;
  }

  if (changes.length === 0) return { compose: source, changes: [] };
  return { compose: String(doc), changes };
}

/* ------------------------------------------------------------------ */
/* Compose: a service name the network already answers to              */
/* ------------------------------------------------------------------ */

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
 * Whether this env key holds a HOSTNAME as its whole value.
 *
 * The tail alone is not enough - `GHOST` ends in HOST and is an app, not a host -
 * and anchoring the tail to a `_` was not either: `PAPERLESS_DBHOST` glues the
 * word onto `DB`, so a rename left it pointing at a service that no longer
 * existed, and the app spent its life restarting against a NEIGHBOUR's database.
 * A separator anywhere in the key is what tells the two apart.
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

/** The `environment:` block in either of its two shapes. */
function rewriteEnvNode(node: unknown, renames: Map<string, string>): void {
  if (isMap(node)) {
    for (const item of node.items) {
      const value = item.value;
      if (!isScalar(value) || typeof value.value !== "string") continue;
      const e = {
        key: String((item.key as Scalar).value),
        value: value.value,
      };
      if (renameHostTokens([e], renames).length > 0) value.value = e.value;
    }
  } else if (isSeq(node)) {
    for (const item of node.items) {
      if (!isScalar(item) || typeof item.value !== "string") continue;
      const raw: string = item.value;
      const eq = raw.indexOf("=");
      if (eq < 0) continue;
      const e = { key: raw.slice(0, eq), value: raw.slice(eq + 1) };
      if (renameHostTokens([e], renames).length > 0)
        item.value = `${e.key}=${e.value}`;
    }
  }
}

/**
 * Rename every service whose DNS name a neighbour on the destination network
 * already answers to, and carry the references with it.
 *
 * An Environment is one network (ADR-0028), and two one-click stacks both calling
 * their database `db` is the ordinary case, not the exotic one - refusing the
 * second one lost the whole app. Rewriting beats refusing: the same YAML arrives
 * from an import, and only the import knows what is already there.
 */
export function renameClashingServices(
  source: string,
  /** Lowercase names a neighbour answers to on the destination network. */
  taken: Set<string>,
  /** What to qualify a renamed service with - the app's own name. */
  prefix: string,
): { compose: string; renames: Map<string, string>; changes: string[] } {
  const renames = new Map<string, string>();
  const unchanged = { compose: source, renames, changes: [] as string[] };
  if (taken.size === 0) return unchanged;
  const doc = readComposeDoc(source);
  if (!doc) return unchanged;
  const root = doc.contents as YAMLMap;
  const services = root.get("services", true);
  if (!isMap(services)) return unchanged;

  const base =
    prefix
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "app";
  const used = new Set(
    services.items.map((i) => String((i.key as Scalar).value).toLowerCase()),
  );
  const changes: string[] = [];
  /** A free name for `name`, qualified by this app and unique on the network. */
  const freeName = (name: string): string => {
    let next = `${base}-${name}`;
    for (
      let i = 2;
      taken.has(next.toLowerCase()) || used.has(next.toLowerCase());
      i++
    )
      next = `${base}-${name}-${i}`;
    used.add(next.toLowerCase());
    return next;
  };

  for (const item of services.items) {
    const key = item.key as Scalar;
    const name = String(key.value);
    if (!taken.has(name.toLowerCase())) continue;
    const next = freeName(name);
    key.value = next;
    renames.set(name.toLowerCase(), next);
    changes.push(
      `\`${name}\` is already answered by something else on this environment's network, so this stack's service is \`${next}\` here - everything that named it came with it.`,
    );
  }

  // `hostname:` is registered in Docker's DNS exactly like a service name, so a
  // stack that renamed no service can still be claiming a taken one.
  for (const { map: holder } of serviceLikeMaps(root)) {
    const host = stringScalar(holder, "hostname");
    if (!host) continue;
    const name = (host.value as string).trim();
    if (!taken.has(name.toLowerCase())) continue;
    const next = renames.get(name.toLowerCase()) ?? freeName(name);
    host.value = next;
    if (!renames.has(name.toLowerCase())) {
      renames.set(name.toLowerCase(), next);
      changes.push(
        `Its \`hostname: ${name}\` is already answered on this environment's network, so it is \`${next}\` here.`,
      );
    }
  }

  if (renames.size === 0) return unchanged;

  for (const { map: holder } of serviceLikeMaps(root)) {
    const dep = holder.get("depends_on", true);
    if (isSeq(dep))
      for (const item of dep.items) {
        if (!isScalar(item) || typeof item.value !== "string") continue;
        const to = renames.get(item.value.trim().toLowerCase());
        if (to) item.value = to;
      }
    else if (isMap(dep))
      for (const item of dep.items) {
        const key = item.key as Scalar;
        const to = renames.get(String(key.value).trim().toLowerCase());
        if (to) key.value = to;
      }

    const links = holder.get("links", true);
    if (isSeq(links))
      for (const item of links.items) {
        if (!isScalar(item) || typeof item.value !== "string") continue;
        const [named, alias] = item.value.split(":");
        const to = renames.get(named.trim().toLowerCase());
        if (to) item.value = alias ? `${to}:${alias}` : to;
      }

    rewriteEnvNode(holder.get("environment", true), renames);
  }

  return { compose: String(doc), renames, changes };
}

/**
 * Docker's own rule for telling a NAMED volume from a path: no separator, and no
 * leading `.`, `~` or `$`.
 */
const NAMED_VOLUME_SOURCE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

function isNamedVolumeSource(source: string): boolean {
  return NAMED_VOLUME_SOURCE.test(source.trim());
}

/**
 * A volume NAME somebody typed a slash onto (`memos/`). Compose reads a source
 * with no leading `./`, `../` or `/` as a volume name, so this is not a path -
 * it is a name it will then refuse the whole stack over, undeclared and
 * undeclarable. The platform that stored it normalises it on render; Deplo has
 * the file as written, so it normalises it here.
 */
const VOLUME_NAME_WITH_SLASH = /^([A-Za-z0-9][A-Za-z0-9_.-]*)\/+$/;

function trailingSlashOffVolume(source: string): string | null {
  return VOLUME_NAME_WITH_SLASH.exec(source.trim())?.[1] ?? null;
}

/**
 * Declare every named volume the services mount that the file itself does not.
 *
 * A one-click template's compose is a FRAGMENT: the platform synthesises the
 * top-level `volumes:` block when it renders one, so the file as stored is
 * refused outright - "service X refers to undefined volume Y: invalid compose
 * project" - and the stack never starts.
 */
function declareMissingVolumes(
  doc: Document,
  root: YAMLMap,
  mounted: Set<string>,
  changes: string[],
): void {
  if (mounted.size === 0) return;
  const declared = root.get("volumes", true);
  const known = isMap(declared)
    ? new Set(declared.items.map((i) => String((i.key as Scalar).value)))
    : new Set<string>();
  const missing = [...mounted].filter((v) => !known.has(v));
  if (missing.length === 0) return;

  if (isMap(declared)) for (const name of missing) declared.set(name, null);
  else
    root.set(
      "volumes",
      doc.createNode(Object.fromEntries(missing.map((n) => [n, null]))),
    );
  changes.push(
    `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} declared at the top of the compose file - {panel} added that block when it rendered the stack, and without it the stack will not start.`,
  );
}

/**
 * Point an `env_file` at the env file DEPLO writes, when the stack names one it
 * did not bring with it. The rule is deliberately narrow: an entry is retargeted
 * ONLY when the file is not one this app carries.
 */
export function retargetPlatformEnvFiles(
  source: string,
  carried: string[],
): { compose: string; changes: string[] } {
  const doc = readComposeDoc(source);
  if (!doc) return { compose: source, changes: [] };
  const root = doc.contents as YAMLMap;

  const have = new Set(
    carried.map((f) =>
      f
        .trim()
        .replace(/^\.\/+/, "")
        .replace(/^\/+/, ""),
    ),
  );
  const changes: string[] = [];
  const retarget = (value: string): string | null => {
    const named = value.trim().replace(/^\.\/+/, "");
    if (!named || named === ".env") return null;
    // An absolute path or one climbing out is a host path, not the platform's
    // env file - the compose gates decide about those, not this.
    if (named.startsWith("/") || named.split("/").includes("..")) return null;
    if (have.has(named)) return null;
    return "./.env";
  };

  for (const { name: who, map: holder } of serviceLikeMaps(root)) {
    for (const target of envFileScalars(holder)) {
      const next = retarget(target.value as string);
      if (!next) continue;
      changes.push(
        `${who} reads its variables from ${target.value}, which is the file the other platform wrote. It now reads Deplo's own - the values are this app's variables.`,
      );
      target.value = next;
    }
  }

  if (changes.length === 0) return { compose: source, changes: [] };
  return { compose: String(doc), changes };
}

/** A compose document worth rewriting: it parsed, and its root is a mapping. */
function readComposeDoc(source: string): Document | null {
  let doc: Document;
  try {
    doc = yaml.parseDocument(source);
  } catch {
    return null;
  }
  if (doc.errors.length > 0 || !isMap(doc.contents)) return null;
  // Re-serializing the document is what loses `UMASK: 022`, so the text is pinned
  // before anything edits it.
  keepAuthoredEnvText(doc);
  return doc;
}

/** A node as plain data, for the readers that want the value and not the node. */
function toPlain(node: unknown): unknown {
  try {
    return (node as { toJSON?: () => unknown } | null)?.toJSON?.() ?? node;
  } catch {
    return null;
  }
}

/** Every `env_file` entry of one service-like map, in all three shapes. */
function envFileScalars(holder: YAMLMap): Scalar[] {
  const out: Scalar[] = [];
  const node = holder.get("env_file", true);
  if (isScalar(node) && typeof node.value === "string") out.push(node);
  else if (isSeq(node))
    for (const entry of node.items) {
      if (isScalar(entry) && typeof entry.value === "string") out.push(entry);
      else if (isMap(entry)) {
        const path = stringScalar(entry, "path");
        if (path) out.push(path);
      }
    }
  return out;
}

/**
 * Every place OUTSIDE `services[].volumes` where a compose file names a file next
 * to itself: the env files, the label files, a build context, and the `secrets` /
 * `configs` blocks.
 */
function composeFileRefs(root: YAMLMap): [string, Scalar][] {
  const out: [string, Scalar][] = [];
  for (const { name: who, map: holder } of serviceLikeMaps(root)) {
    for (const target of envFileScalars(holder))
      out.push([`${who}.env_file`, target]);

    const label = holder.get("label_file", true);
    if (isScalar(label) && typeof label.value === "string")
      out.push([`${who}.label_file`, label]);
    else if (isSeq(label))
      for (const entry of label.items)
        if (isScalar(entry) && typeof entry.value === "string")
          out.push([`${who}.label_file`, entry]);

    const build = holder.get("build", true);
    if (isScalar(build) && typeof build.value === "string")
      out.push([`${who}.build`, build]);
    else if (isMap(build)) {
      const context = stringScalar(build, "context");
      if (context) out.push([`${who}.build`, context]);
    }
  }

  for (const block of ["secrets", "configs"] as const) {
    const declared = root.get(block, true);
    if (!isMap(declared)) continue;
    for (const item of declared.items) {
      if (!isMap(item.value)) continue;
      const file = stringScalar(item.value, "file");
      if (file)
        out.push([`${block}.${String((item.key as Scalar).value)}`, file]);
    }
  }
  return out;
}

/**
 * Where the other platform keeps a stack's own files. Dokploy writes them beside
 * the compose (`../files/x`); Coolify writes them under its data directory.
 */
const PLATFORM_FILES_RE = [
  /^\.\.\/files(?:\/(.*))?$/,
  /^\/data\/coolify\/(?:applications|services)\/[^/]+(?:\/(.*))?$/,
];

/**
 * The source platform's own files directory as Deplo spells it, or null when the
 * source is not one (a named volume, a real host path, an escape to somewhere else).
 */
export function deploFilesPath(source: string): string | null {
  const s = source.trim();
  for (const re of PLATFORM_FILES_RE) {
    const m = re.exec(s);
    if (!m) continue;
    const rest = (m[1] ?? "").replace(/^\/+/, "");
    return rest ? `./${rest}` : ".";
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Build settings                                                      */
/* ------------------------------------------------------------------ */

const BUILD_METHOD: Record<string, BuildMethod> = {
  dockerfile: "dockerfile",
  nixpacks: "nixpacks",
  railpack: "railpack",
  static: "static",
  // Neither buildpack family has a deplo equivalent. Nixpacks is the closest
  // thing: an auto-detecting builder that reads the same repos. Noted, never
  // silent - a Heroku buildpack with a custom `bin/compile` will not survive it.
  heroku_buildpacks: "nixpacks",
  paketo_buildpacks: "nixpacks",
};

/**
 * Dokploy's per-service build fields → deplo's `BuildConfig`.
 */
export function mapBuildSettings(
  app: SourceApplication,
): Mapped<Partial<BuildConfig>> {
  const notes: string[] = [];
  const buildMethod = BUILD_METHOD[app.buildType] ?? "nixpacks";
  if (
    app.buildType === "heroku_buildpacks" ||
    app.buildType === "paketo_buildpacks"
  )
    notes.push(
      `Built with ${app.buildType.replace("_", " ")} on {panel}. Set to Nixpacks - check the build.`,
    );

  const build: Partial<BuildConfig> = { buildMethod };
  const methodSettings: BuildConfig["methodSettings"] = {};

  // ONLY the settings the chosen builder reads.
  if (buildMethod === "dockerfile") {
    if (app.dockerfile?.trim())
      methodSettings.dockerfilePath = app.dockerfile.trim();
    if (app.dockerContextPath?.trim())
      methodSettings.dockerContextPath = app.dockerContextPath.trim();
    if (app.dockerBuildStage?.trim())
      methodSettings.dockerBuildStage = app.dockerBuildStage.trim();
  }
  if (buildMethod === "railpack" && app.railpackVersion?.trim())
    methodSettings.railpackVersion = app.railpackVersion.trim();

  const publish = app.publishDirectory?.trim();
  if (buildMethod === "static") {
    if (publish) build.outputDirectory = publish;
    if (app.isStaticSpa) methodSettings.staticSinglePageApp = true;
  } else if (buildMethod === "nixpacks" && publish) {
    methodSettings.nixpacksPublishDirectory = publish;
  }
  if (Object.keys(methodSettings).length > 0)
    build.methodSettings = methodSettings;

  const root = buildPathFor(app);
  if (root) build.rootDirectory = root;

  // Dokploy's `command` overrides the container's command; deplo's closest field
  // is the builder's start command. Same intent, different layer for a
  // Dockerfile build (where deplo leaves CMD alone), hence the note.
  const command = app.command?.trim();
  if (command) {
    build.startCommand = command;
    if (buildMethod === "dockerfile")
      notes.push(
        `Container command "${truncate(command, 80)}" became the start command. A Dockerfile keeps its own CMD.`,
      );
  }

  if ((app.replicas ?? 1) > 1)
    notes.push(
      `Runs ${app.replicas} replicas on {panel}. Deplo runs one container per app, so it arrives as one.`,
    );

  return { value: build, notes };
}

/** The repo subdirectory to build from, whichever provider the app uses. */
function buildPathFor(app: SourceApplication | SourceCompose): string | null {
  const candidates = [
    (app as SourceApplication).buildPath,
    (app as SourceApplication).gitlabBuildPath,
    (app as SourceApplication).giteaBuildPath,
    (app as SourceApplication).bitbucketBuildPath,
    (app as SourceApplication).customGitBuildPath,
  ];
  for (const c of candidates) {
    const v = c?.trim();
    if (v && v !== "/" && v !== "./") return v;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Resource limits                                                     */
/* ------------------------------------------------------------------ */

const MEM_UNITS: Record<string, number> = {
  b: 1 / (1024 * 1024),
  k: 1 / 1024,
  kb: 1 / 1024,
  ki: 1 / 1024,
  kib: 1 / 1024,
  m: 1,
  mb: 1,
  mi: 1,
  mib: 1,
  g: 1024,
  gb: 1024,
  gi: 1024,
  gib: 1024,
};

/** Docker's memory grammar (`512m`, `1g`, `1.5Gi`, or a bare byte count) → MiB. */
export function parseMemoryMb(raw: string | null | undefined): number | null {
  const s = raw?.trim().toLowerCase();
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/.exec(s);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2];
  // A bare number in this column is bytes, which is what Docker's API takes and
  // what Dokploy's own forms sometimes hold.
  const factor = unit ? MEM_UNITS[unit] : 1 / (1024 * 1024);
  if (factor === undefined) return null;
  const mb = Math.round(n * factor);
  return mb >= 1 ? mb : null;
}

/**
 * Dokploy's CPU limit → deplo's milli-CPUs.
 *
 * ponytail: the column is free text and holds two conventions - cores as a
 * decimal (`0.5`, what Dokploy's form asks for) and nano-CPUs (`500000000`, what
 * Docker's API takes). Split on 1000, because a 1000-core limit is not a thing
 * anyone types and half a nano-CPU is not either. If a third convention ever
 * shows up, this is the line to change.
 */
export function parseCpuMilli(raw: string | null | undefined): number | null {
  const s = raw?.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  const milli = n > 1000 ? Math.round(n / 1_000_000) : Math.round(n * 1000);
  return milli >= 10 ? milli : null;
}

/**
 * `0` in any of Docker's limit flags means NO limit, and it is what one panel
 * writes in every column of every app. Read as an unparsable value it produced
 * three false alarms per application, which is how a real one goes unread.
 */
const NO_LIMIT = /^0+(\.0+)?\s*[a-z]*$/i;

function isNoLimit(raw: string | null | undefined): boolean {
  return NO_LIMIT.test((raw ?? "").trim());
}

/** Dokploy's four limit columns → deplo's `resource_*`. Null when nothing was set. */
export function mapResources(row: {
  memoryLimit?: string | null;
  memoryReservation?: string | null;
  cpuLimit?: string | null;
  cpuReservation?: string | null;
}): Mapped<ResourceInput | null> {
  const notes: string[] = [];
  const memoryMb = parseMemoryMb(row.memoryLimit);
  const memoryReservationMb = parseMemoryMb(row.memoryReservation);
  const cpuMilli = parseCpuMilli(row.cpuLimit);

  for (const [label, raw, parsed] of [
    ["Memory limit", row.memoryLimit, memoryMb],
    ["Memory reservation", row.memoryReservation, memoryReservationMb],
    ["CPU limit", row.cpuLimit, cpuMilli],
  ] as const)
    if (raw?.trim() && parsed == null && !isNoLimit(raw))
      notes.push(
        `${label} "${raw.trim()}" is not a value Deplo can read - set it by hand.`,
      );

  // Dokploy's cpuReservation is a swarm scheduling hint with no deplo column.
  if (row.cpuReservation?.trim() && !isNoLimit(row.cpuReservation))
    notes.push(
      `CPU reservation "${row.cpuReservation.trim()}" is a Swarm placement hint. Deplo has no equivalent, so it is not imported.`,
    );

  // A reservation above the limit is what deplo's own validator refuses; drop it
  // rather than lose the limit too.
  const reservation =
    memoryReservationMb != null &&
    memoryMb != null &&
    memoryReservationMb > memoryMb
      ? null
      : memoryReservationMb;
  if (reservation !== memoryReservationMb)
    notes.push(
      "Memory reservation is above the limit on {panel} - not imported.",
    );

  if (memoryMb == null && reservation == null && cpuMilli == null)
    return { value: null, notes };
  return {
    value: { memoryMb, memoryReservationMb: reservation, cpuMilli },
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* Icon                                                                */
/* ------------------------------------------------------------------ */

/**
 * The service's icon, carried over as-is. Those come back `null` rather than
 * throwing: an icon is decoration, and losing it must never be the reason a
 * service fails to import.
 */
export function mapLogo(icon: string | null | undefined): string | null {
  const value = icon?.trim();
  if (!value) return null;
  return isValidLogoValue(value) ? value : null;
}

/* ------------------------------------------------------------------ */
/* Git source                                                          */
/* ------------------------------------------------------------------ */

/** A source deplo can deploy, or null when the app has to be rebuilt by hand. */
export type MappedSource =
  | { kind: "git"; repo: GitRepo }
  | { kind: "docker-image"; image: string }
  | { kind: "none" };

const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;

/** Source kinds that mean "cloned through an account the panel had connected",
 *  which is the only shape that may need a credential Deplo does not have. */
const CONNECTED_PROVIDER = new Set(["github", "gitlab", "gitea", "bitbucket"]);

/**
 * Where the app's code comes from.
 */
export function mapSource(app: SourceApplication): Mapped<MappedSource> {
  const notes: string[] = [];

  if (app.sourceType === "docker") {
    const image = app.dockerImage?.trim();
    if (!image) {
      notes.push("Docker source with no image set on {panel} - pick an image.");
      return { value: { kind: "none" }, notes };
    }
    if (!IMAGE_REF_RE.test(image)) {
      notes.push(
        `Image reference "${truncate(image, 80)}" is not one Deplo accepts - set it by hand.`,
      );
      return { value: { kind: "none" }, notes };
    }
    // A private pull can be configured two ways over there: a registry ENTITY, or a
    // username/password/URL typed straight onto the application (`saveDockerProvider`).
    if (app.registryId || app.registry || app.username || app.registryUrl)
      notes.push(
        "From a private registry. Add it under Registries and reselect it - {panel} never exposes the password.",
      );
    // A registry running ON the source host. The reference is perfectly valid over
    // there and means nothing here, and the failure it produces later ("pull
    // access denied") points at the image rather than at the move.
    if (/^(localhost|127\.0\.0\.1|::1|host\.docker\.internal)[:/]/i.test(image))
      notes.push(
        `${image} is in a registry on the {panel} machine. Push it somewhere Deplo can reach, or build from source.`,
      );
    return { value: { kind: "docker-image", image }, notes };
  }

  if (app.sourceType === "drop") {
    notes.push(
      "Its code is an archive somebody uploaded to {panel}, and the API will not hand the file over. Upload it again here.",
    );
    return { value: { kind: "none" }, notes };
  }

  const repo = cloneTarget(app);
  if (!repo) {
    notes.push(
      "Could not work out the repository from {panel} - set the source by hand.",
    );
    return { value: { kind: "none" }, notes };
  }

  // Only when the SOURCE needed one. Said for every git app, this was the most
  // frequent line in the report and false for most of them: a public repository
  // clones here exactly as it cloned there, and the count of things needing a
  // person made the whole migration look like manual work that was not.
  if (app.customGitSSHKeyId)
    notes.push(
      "Clones over SSH with a key stored in {panel}. Deplo clones over https, so add a git connection for this host.",
    );
  else if (
    app.gitNeedsCredential ||
    CONNECTED_PROVIDER.has(app.sourceType) ||
    /^(ssh:\/\/|[^/\s]+@[^/\s]+:)/.test(repo.url)
  )
    notes.push(
      `${repo.repo} came from an account connected to {panel}, so no credential came with it. Attach a git connection if the repository is private - that also turns on auto-deploy.`,
    );

  return {
    value: {
      kind: "git",
      repo: {
        ...repo,
        triggerType: app.triggerType === "tag" ? "tag" : "push",
        watchPaths: (app.watchPaths ?? []).filter((p) => p.trim()),
        submodules: app.enableSubmodules === true,
      },
    },
    notes,
  };
}

/** The `owner/name`, branch and https URL for whichever provider is configured. */
export function cloneTarget(
  app: SourceApplication | SourceCompose,
): GitRepo | null {
  const a = app as SourceApplication;
  // Origin AND path: a self-hosted GitLab or Gitea behind a reverse proxy lives at
  // `https://acme.com/gitlab`, and dropping the prefix clones a 404.
  const host = (raw: string | null | undefined, fallback: string): string => {
    const v = raw?.trim();
    if (!v) return fallback;
    try {
      const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
      return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
    } catch {
      return fallback;
    }
  };

  switch (app.sourceType) {
    case "github": {
      if (!a.owner || !a.repository) return null;
      return {
        provider: "github",
        url: `https://github.com/${a.owner}/${a.repository}.git`,
        repo: `${a.owner}/${a.repository}`,
        branch: a.branch?.trim() || "main",
      };
    }
    case "gitlab": {
      // `gitlabPathNamespace` is the FULL project path, not the namespace its name
      // suggests: Dokploy clones `<host>/<gitlabPathNamespace>.git`. Appending the
      // repository to it produced `group/repo/repo.git`, a 404 on every app.
      const owner = a.gitlabOwner?.trim();
      const repository = a.gitlabRepository?.trim();
      const path =
        a.gitlabPathNamespace?.trim() ||
        (owner && repository ? `${owner}/${repository}` : "");
      if (!path) return null;
      const origin = host(a.gitlab?.gitlabUrl, "https://gitlab.com");
      return {
        provider: "gitlab",
        url: `${origin}/${path}.git`,
        repo: path,
        branch: a.gitlabBranch?.trim() || "main",
      };
    }
    case "gitea": {
      if (!a.giteaOwner || !a.giteaRepository) return null;
      const origin = host(a.gitea?.giteaUrl, "https://gitea.com");
      return {
        provider: "gitea",
        url: `${origin}/${a.giteaOwner}/${a.giteaRepository}.git`,
        repo: `${a.giteaOwner}/${a.giteaRepository}`,
        branch: a.giteaBranch?.trim() || "main",
      };
    }
    case "bitbucket": {
      const slug =
        a.bitbucketRepositorySlug?.trim() || a.bitbucketRepository?.trim();
      if (!a.bitbucketOwner || !slug) return null;
      return {
        provider: "bitbucket",
        url: `https://bitbucket.org/${a.bitbucketOwner}/${slug}.git`,
        repo: `${a.bitbucketOwner}/${slug}`,
        branch: a.bitbucketBranch?.trim() || "main",
      };
    }
    case "git": {
      const url = a.customGitUrl?.trim();
      if (!url) return null;
      return {
        provider: "git",
        url,
        repo: repoNameFromUrl(url),
        branch: a.customGitBranch?.trim() || "main",
      };
    }
    default:
      return null;
  }
}

/** `owner/name` out of any clone URL, https or scp-style. */
export function repoNameFromUrl(url: string): string {
  const cleaned = url
    .trim()
    .replace(/\.git$/i, "")
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^[^/:]+[:/]/, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts.slice(-2).join("/") || cleaned;
}

/* ------------------------------------------------------------------ */
/* Domains                                                             */
/* ------------------------------------------------------------------ */

/**
 * Hostnames that only ever meant "the box this used to run on": Dokploy's
 * generated `traefik.me` names and the wildcard-DNS services that encode an IP.
 */
const THROWAWAY_HOST_RE = /(^|\.)(traefik\.me|sslip\.io|nip\.io|localhost)$/i;

export function isThrowawayHost(host: string): boolean {
  return THROWAWAY_HOST_RE.test(host.trim().toLowerCase());
}

export interface MappedDomain {
  /**
   * The hostname on the SOURCE. When {@link generated} is true this name does
   * NOT come across - it is kept only so the report can say what became what.
   */
  host: string;
  port: number | null;
  pathPrefix: string;
  stripPrefix: boolean;
  certProvider: CertProvider;
  entrypoint: DomainEntrypoint;
  service: string | null;
  /**
   * The source host was the other platform's own THROWAWAY address - a
   * `*.sslip.io` / `*.traefik.me` / `*.nip.io` name with its server's IP baked in.
   */
  generated: boolean;
}

/**
 * The domains worth importing, in Dokploy's own order (the first survivor becomes
 * deplo's primary).
 */
export function mapDomains(
  domains: SourceDomain[] | null | undefined,
  opts: {
    isCompose: boolean;
    fallbackPort?: number | null;
    /** The stack's own YAML, so a route that names a service but no port can
     *  read the port off that service instead of arriving with none. */
    compose?: string | null;
  },
): Mapped<MappedDomain[]> {
  const notes: string[] = [];
  const out: MappedDomain[] = [];
  for (const d of domains ?? []) {
    const host = d.host?.trim().toLowerCase();
    if (!host) continue;
    if (d.domainType === "preview") continue;
    if (d.enabled === false) continue;

    let certProvider: CertProvider = "none";
    if (d.certificateType === "letsencrypt") certProvider = "letsencrypt";
    else if (d.certificateType === "custom")
      notes.push(
        `${host} uses a custom certificate resolver on {panel}. Imported without a certificate - pick one in Domains.`,
      );

    const path = (d.path ?? "/").trim();
    const pathPrefix = path === "/" ? "" : path;
    // Dokploy can rewrite the path on the way to the container.
    const internal = (d.internalPath ?? "").trim();
    if (internal && internal !== "/")
      notes.push(
        `${host} rewrites the path to ${internal} before the container sees it. Deplo forwards the path as it is (or strips the prefix), so the app now receives ${pathPrefix || "/"} - check that it serves that.`,
      );
    // Deplo has two entrypoints, web and websecure. A route on any other one
    // lands on websecure, and that has to be said rather than discovered.
    const custom = (d.customEntrypoint ?? "").trim();
    if (custom && custom !== "web" && custom !== "websecure")
      notes.push(
        `${host} answered on {panel}'s "${custom}" entrypoint. Deplo has only web and websecure, so it comes across on websecure - open that port on this app if it needs one.`,
      );
    const service = opts.isCompose ? d.serviceName?.trim() || null : null;
    // A one-click template that declares `SERVICE_FQDN_<NAME>` without the
    // `_<PORT>` spelling records no port at all, and a stack route with none used
    // to arrive empty - which is a 404 on the address the panel printed.
    const read =
      opts.isCompose && service
        ? composeRoutePort(opts.compose, service)
        : null;
    const port = d.port ?? opts.fallbackPort ?? read;
    if (opts.isCompose && d.port == null && opts.fallbackPort == null)
      notes.push(
        port == null
          ? `${host} has no container port set - Deplo needs one for a compose stack.`
          : `${host} carried no container port on {panel}, so Deplo routes it to ${service} on port ${port} - what that service publishes, or the usual web port. Change it under Domains if it answers somewhere else.`,
      );

    out.push({
      host,
      port,
      pathPrefix,
      stripPrefix: pathPrefix ? d.stripPath === true : false,
      certProvider,
      entrypoint:
        d.https === false && certProvider === "none" ? "web" : "websecure",
      service,
      generated: isThrowawayHost(host),
    });
  }
  return { value: out, notes };
}

/* ------------------------------------------------------------------ */
/* Mounts                                                             */
/* ------------------------------------------------------------------ */

export interface MappedMounts {
  /**
   * Config files that must exist in the stack's files dir, with the container path
   * Dokploy mounted each one at (empty for a compose stack's, whose YAML does the
   * binding itself).
   */
  files: { filePath: string; content: string; mountPath: string }[];
  /** Named volumes and host binds, for `setAppVolumes`. */
  volumes: Omit<VolumeMount, "id">[];
}

/** lowercase-kebab, which is what deplo requires of a volume label. */
export function volumeLabel(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return cleaned || fallback;
}

/**
 * The file's name in the app's files dir, taken from the only address a mount
 * with no `filePath` has: the path it is mounted at inside the container
 * ("/etc/nginx/nginx.conf" -> "nginx.conf").
 */
function fileNameFromMountPath(mountPath: string): string {
  const last = mountPath
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .pop();
  return last ?? "";
}

/**
 * `base`, or the first `<stem>-<n>.<ext>` nobody has taken yet.
 */
function uniqueFilePath(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  const slash = base.lastIndexOf("/") + 1;
  const dot = base.indexOf(".", slash + 1);
  const stem = dot < 0 ? base : base.slice(0, dot);
  const ext = dot < 0 ? "" : base.slice(dot);
  let name = base;
  for (let i = 2; ; i++) {
    name = `${stem}-${i}${ext}`;
    if (!used.has(name)) break;
  }
  used.add(name);
  return name;
}

/**
 * Dokploy's three mount kinds -> deplo's writers.
 */
export function mapMounts(
  mounts: SourceMount[] | null | undefined,
  opts: { isCompose: boolean; compose?: string | null },
): Mapped<MappedMounts> {
  const notes: string[] = [];
  const files: MappedMounts["files"] = [];
  const volumes: Omit<VolumeMount, "id">[] = [];
  const used = new Set<string>();
  const usedFiles = new Set<string>();
  const composeMounts = new Set(
    opts.isCompose ? composeMountPaths(opts.compose) : [],
  );

  for (const m of mounts ?? []) {
    const mountPath = m.mountPath?.trim();
    if (m.type === "file") {
      // Deplo owns the whole files dir, so only the file's own name travels -
      // never Dokploy's `../files/` prefix and never an absolute path.
      const declared = (m.filePath ?? "")
        .trim()
        .replace(/^\.\/+/, "")
        .replace(/^\/+|\/+$/g, "");
      const wanted = declared || fileNameFromMountPath(mountPath ?? "");
      if (!wanted || wanted.split("/").includes("..")) {
        notes.push(
          "A file mount has no usable path on {panel} - not imported.",
        );
        continue;
      }
      const name = uniqueFilePath(wanted, usedFiles);
      if (name !== wanted)
        notes.push(
          `Two file mounts are both called ${wanted}, so one of them is ${name} in this app's Files.`,
        );
      files.push({
        filePath: name,
        content: m.content ?? "",
        mountPath: mountPath ?? "",
      });
      // Only an application needs the pairing: a compose stack already binds the
      // file in its own YAML, and a second mount for it would fight that one.
      if (!opts.isCompose && mountPath)
        volumes.push({
          type: "app",
          name: volumeLabel(name, "file"),
          projectPath: name,
          mountPath,
          readOnly: false,
        });
      continue;
    }
    if (!mountPath) {
      notes.push("A mount has no container path on {panel} - not imported.");
      continue;
    }
    if (m.type === "volume") {
      // The stack's own YAML already binds this path, so a Storage row for it
      // would be a volume the deploy never mounts - and the one the data copy
      // then filled, while the stack came up on the empty one beside it.
      if (opts.isCompose && composeMounts.has(mountPath.replace(/\/+$/, "")))
        continue;
      const base = volumeLabel(
        m.volumeAlias ?? m.volumeName ?? "",
        volumeLabel(mountPath, "data"),
      );
      let name = base;
      for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
      used.add(name);
      volumes.push({ type: "named", name, mountPath, readOnly: false });
      continue;
    }
    // bind
    const hostPath = m.hostPath?.trim();
    if (!hostPath) {
      notes.push(
        `Bind mount at ${mountPath} has no host path on {panel} - not imported.`,
      );
      continue;
    }
    volumes.push({
      type: "host",
      name: volumeLabel(mountPath, "bind"),
      hostPath,
      mountPath,
      readOnly: false,
    });
  }

  return { value: { files, volumes }, notes };
}

/* ------------------------------------------------------------------ */
/* Databases                                                           */
/* ------------------------------------------------------------------ */

const DB_ENGINE: Record<string, DatabaseType> = {
  postgres: "postgres",
  mysql: "mysql",
  mariadb: "mariadb",
  mongo: "mongodb",
  redis: "redis",
  // Coolify's own spellings. keydb and dragonfly speak RESP but store their own
  // formats, and libsql has no twin at all: all three answer null.
  postgresql: "postgres",
  mongodb: "mongodb",
  clickhouse: "clickhouse",
};

/**
 * The deplo engine for one of the source platform's database tables, or null when
 * there is none (libsql, keydb, dragonfly).
 */
export function deploEngineFor(kind: string): DatabaseType | null {
  return DB_ENGINE[kind] ?? null;
}

export interface MappedDatabase {
  type: DatabaseType;
  name: string;
  /** The source image's tag, or "latest" when it had none. Display only - the
   *  image a database actually runs is {@link MappedDatabase.customImage}. */
  version: string;
  username: string | null;
  dbName: string | null;
  password: string | null;
  exposedPort: number | null;
  /** The image Dokploy ran, ALWAYS kept verbatim - see `mapDatabase`. */
  customImage: string;
  /**
   * The start command Dokploy overrode, or null.
   */
  command: string | null;
  /** The engine's config files, in deplo's shape. Almost always empty. */
  mounts: { filePath: string; content: string; mountPath: string }[];
}

/** The version tag out of an image ref, ignoring a registry port. */
export function imageTag(image: string | null | undefined): string | null {
  const s = image?.trim();
  if (!s) return null;
  const at = s.indexOf("@");
  const ref = at === -1 ? s : s.slice(0, at);
  const slash = ref.lastIndexOf("/");
  const colon = ref.lastIndexOf(":");
  if (colon === -1 || colon < slash) return null;
  const tag = ref.slice(colon + 1).trim();
  return /^[A-Za-z0-9._-]+$/.test(tag) ? tag : null;
}

/** The repository half of an image ref (`bitnami/postgresql:15` → `bitnami/postgresql`). */
function imageRepo(image: string | null | undefined): string | null {
  const s = image?.trim();
  if (!s) return null;
  const tag = imageTag(s);
  return tag ? s.slice(0, s.length - tag.length - 1) : s;
}

/**
 * One of Dokploy's five database tables → `createDatabase` input.
 */
export function mapDatabase(
  kind: SourceDbKind,
  row: SourceDatabase,
): Mapped<MappedDatabase | null> {
  const notes: string[] = [];
  const type = deploEngineFor(kind);
  if (!type) {
    notes.push(
      kind === "unknown"
        ? `${row.name}: {panel} does not say which engine this database runs, so Deplo could not create it. Add it here and copy its data over.`
        : `${row.name}: Deplo has no ${kind} engine - not imported.`,
    );
    return { value: null, notes };
  }

  // The source's EXACT image is kept, canonical or not - deplo never re-derives one
  // here. Data must be reopened by the binary that wrote it.
  const customImage = row.dockerImage?.trim() || `${kind}:latest`;
  const tag = imageTag(customImage);
  const version = tag ?? "latest";
  if (!tag)
    notes.push(
      `{panel} runs ${customImage} with no version pinned, so what it resolves to can change under the data. Pin a version under Advanced.`,
    );
  const repo = imageRepo(row.dockerImage);
  const canonical =
    !repo ||
    repo === kind ||
    repo === type ||
    repo === `library/${kind}` ||
    (kind === "mongo" && repo === "mongo");
  if (!canonical)
    notes.push(
      `Runs ${customImage} on {panel} instead of a plain ${type}. Kept as it is - check that it starts.`,
    );

  // A multi-line command is not something Deplo's column takes (it renders as a
  // quoted scalar in the compose), so that one still has to be retyped.
  const command = row.command?.trim() || null;
  if (command && /[\r\n\t]/.test(command))
    notes.push(
      `Custom start command on {panel} ("${truncate(command, 60)}") spans more than one line - set it under Advanced if you still need it.`,
    );
  // Dokploy models a database's own DATA volume as a mount row, so counting every
  // mount announced "extra files that are not imported" about the one thing the Data
  // step exists to copy - on every single database.
  const mapped = mapMounts(
    (row.mounts ?? []).filter((m) => m.type === "file"),
    { isCompose: false },
  );
  notes.push(...mapped.notes);
  const binds = (row.mounts ?? []).filter((m) => m.type === "bind");
  if (binds.length > 0)
    notes.push(
      `This database bind-mounts ${binds.length === 1 ? "a folder" : "folders"} from its host on {panel} (${binds
        .map((m) => m.hostPath || m.mountPath)
        .join(
          ", ",
        )}). Deplo databases have no host mounts - move what is in there another way.`,
    );

  // mysql and mariadb keep TWO credentials on Dokploy - an application user and root
  // - while deplo models ONE and uses it for both.
  const rootPassword =
    (type === "mysql" || type === "mariadb") && row.databaseRootPassword?.trim()
      ? row.databaseRootPassword.trim()
      : null;
  // Said whenever root IS the login deplo carries, not only when the two passwords
  // differ: the login changed either way, and half the panels answer with one password.
  if (rootPassword && row.databaseUser?.trim() !== "root")
    notes.push(
      `Connects as root, because that is the login Deplo's own backups and console use and the copied data keeps {panel}'s users. "${row.databaseUser?.trim() || "the application user"}" still works from inside the database.`,
    );

  // A variable that IS a credential deplo carried came across - counting it read
  // as "your password did not make it", which is the opposite of what happened.
  const carried = new Set(
    [
      rootPassword,
      row.databasePassword?.trim(),
      row.databaseUser?.trim(),
      row.databaseName?.trim(),
    ].filter((v): v is string => Boolean(v)),
  );
  const envKeys = parseEnvBlob(row.env)
    .filter((e) => !carried.has(e.value.trim()))
    .map((e) => e.key);
  if (envKeys.length > 0)
    notes.push(
      `Carried ${envKeys.length} environment variable(s) on {panel} (${envKeys.join(", ")}). A Deplo database has none - fold what matters into the image, the start command or a config file under Settings -> Advanced.`,
    );

  return {
    value: {
      type,
      // The tree's row has no name for a database (only its id), so a caller that
      // maps one straight from `project.all` would create "" here. The detail row
      // always has it; the fallback keeps this pure function total either way.
      name: row.name?.trim() || "database",
      version,
      username: rootPassword ? "root" : row.databaseUser?.trim() || null,
      dbName: row.databaseName?.trim() || null,
      password: rootPassword ?? (row.databasePassword?.trim() || null),
      // A real published port or nothing.
      exposedPort:
        typeof row.externalPort === "number" && row.externalPort > 0
          ? row.externalPort
          : null,
      customImage,
      command: command && !/[\r\n\t]/.test(command) ? command : null,
      // Every file mount Dokploy had, named and pathed the way deplo stores
      // them. A file with no container path cannot be mounted anywhere and is
      // dropped by `mapMounts` with a note of its own.
      mounts: mapped.value.files.filter((f) => f.mountPath),
    },
    notes,
  };
}

/* ------------------------------------------------------------------ */
/* The data cutover: pairing volumes                                   */
/* ------------------------------------------------------------------ */

/** A source volume matched to the deplo volume it should be copied into. */
export interface VolumePair {
  sourceVolume: string;
  targetVolume: string;
  /** The container path, when both sides agree on it. */
  mountPath: string;
  /** Set when the pairing was made on something weaker than an equal path. */
  note: string | null;
}

/** Trailing slashes and a missing leading slash are not a difference. */
export function normalizePath(p: string): string {
  const s = p.trim().replace(/\/+$/, "");
  return s.startsWith("/") ? s : `/${s}`;
}

/**
 * The named volumes a `docker inspect` says a container is using.
 */
export function sourceVolumesFrom(inspect: {
  Mounts?: {
    Type?: string;
    Name?: string;
    /** Present on a bind mount; ignored, but part of what docker sends. */
    Source?: string;
    Destination?: string;
  }[];
}): NamedVolume[] {
  const out: NamedVolume[] = [];
  const seen = new Set<string>();
  for (const m of inspect.Mounts ?? []) {
    if (m.Type !== "volume") continue;
    const name = m.Name?.trim();
    const dest = m.Destination?.trim();
    if (!name || !dest || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, mountPath: normalizePath(dest) });
  }
  // Drop a mount whose path is an ANCESTOR of another mount's.
  return out.filter(
    (v) => !out.some((o) => o !== v && isUnderPath(o.mountPath, v.mountPath)),
  );
}

/**
 * The BIND MOUNTS a `docker inspect` says a container is using.
 */
export function sourceBindMountsFrom(inspect: {
  Mounts?: { Type?: string; Source?: string; Destination?: string }[];
}): HostMount[] {
  const out: HostMount[] = [];
  const seen = new Set<string>();
  for (const m of inspect.Mounts ?? []) {
    if (m.Type !== "bind") continue;
    const hostPath = m.Source?.trim();
    const dest = m.Destination?.trim();
    if (!hostPath || !dest || seen.has(dest)) continue;
    seen.add(dest);
    out.push({
      hostPath: normalizePath(hostPath),
      mountPath: normalizePath(dest),
    });
  }
  return out;
}

/** The bind mounts a Dokploy service DECLARES - the fallback for a stopped service,
 *  exactly like `declaredSourceVolumes` is for its named ones. */
export function declaredSourceBindMounts(
  mounts?:
    | {
        type?: string | null;
        hostPath?: string | null;
        mountPath?: string | null;
      }[]
    | null,
  /** A stack binds host directories in its own YAML, where no mount row exists. */
  composeFile?: string | null,
  /** Where that YAML lives on the source machine, so its `./x` binds resolve. */
  stackDir?: string | null,
): HostMount[] {
  const out: HostMount[] = [];
  const seen = new Set<string>();
  for (const m of composeHostMounts(composeFile ?? "", stackDir)) {
    seen.add(m.mountPath);
    out.push(m);
  }
  for (const m of mounts ?? []) {
    if (m?.type !== "bind") continue;
    const hostPath = m.hostPath?.trim();
    const dest = m.mountPath?.trim();
    if (!hostPath || !dest || seen.has(dest)) continue;
    seen.add(dest);
    out.push({
      hostPath: normalizePath(hostPath),
      mountPath: normalizePath(dest),
    });
  }
  return out;
}

/**
 * A `./x` bind source resolved against the directory the stack itself lives in,
 * or null when the source is not one. The SAME rule the renderer applies
 * (`rewriteMountSource`), so the two sides of a copy name the same path.
 */
export function stackRelativePath(
  source: string,
  baseDir: string,
): string | null {
  const s = source.trim();
  if (s.includes("..")) return null; // an escape - the grant gates it, not this
  // `./x` or a bare `.`, never `.env`: a leading dot is not a separator, and
  // inventing `<dir>/env` for it would report a path that is not there.
  const m = /^\.(?:\/(.*))?$/.exec(s);
  if (!m) return null;
  const base = baseDir.replace(/\/+$/, "");
  const rel = (m[1] ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
  return rel ? `${base}/${rel}` : base;
}

/**
 * The host directories a compose file binds ITSELF. Neither side saw one: not the
 * panel's mount rows, not deplo's `app_volumes` - so `- /etc/app:/cfg` arrived in
 * the YAML byte for byte and the directory it names arrived empty.
 *
 * A `./x` source is one too, and pretending otherwise ("the compose import brings
 * it across") lost every relative bind on both panels: only the FILE came over,
 * never the directory it names. It resolves against `baseDir` - the stack's own
 * directory on that machine - and is left out when there is none to resolve with.
 */
export function composeHostMounts(
  compose: string,
  baseDir?: string | null,
): HostMount[] {
  let doc: { services?: Record<string, { volumes?: unknown }> } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return [];
  }
  const out: HostMount[] = [];
  const seen = new Set<string>();
  for (const svc of Object.values(doc?.services ?? {})) {
    if (!Array.isArray(svc?.volumes)) continue;
    for (const raw of svc.volumes) {
      let src: string | undefined;
      let dest: string | undefined;
      if (typeof raw === "string") {
        const parts = raw.split(":");
        src = parts[0]?.trim();
        dest = parts[1]?.trim();
      } else if (raw && typeof raw === "object") {
        const m = raw as { type?: string; source?: string; target?: string };
        if (m.type && m.type !== "bind") continue;
        src = m.source?.trim();
        dest = m.target?.trim();
      }
      if (!src || !dest?.startsWith("/")) continue;
      const relative = baseDir ? stackRelativePath(src, baseDir) : null;
      if (!relative && !src.startsWith("/")) continue;
      const mountPath = normalizePath(dest);
      if (seen.has(mountPath)) continue;
      seen.add(mountPath);
      out.push(
        relative
          ? { hostPath: relative, mountPath, stackRelative: true }
          : { hostPath: normalizePath(src), mountPath },
      );
    }
  }
  return out;
}

/**
 * Host paths that hold no DATA: a socket the runtime owns (`/var/run/docker.sock`
 * above all) and the kernel's pseudo-filesystems. The agent refuses to read one as
 * a directory, and the refusal used to reach the report as a lost volume.
 */
const NOT_DATA_HOST_PATH = /^\/(proc|sys|dev)(\/|$)|\.sock$/;

/** Whether a host path is one a copy has any business reading. */
export function isDataHostPath(hostPath: string): boolean {
  return !NOT_DATA_HOST_PATH.test(hostPath);
}

/**
 * Match every source bind mount to the deplo host mount that should receive it.
 */
export interface PairedHostMount {
  sourcePath: string;
  targetPath: string;
  mountPath: string;
  /** Deplo's own stack directory receives it, so no host path anyone typed is
   *  read or written and the host-volumes grant has nothing to gate. */
  stackRelative: boolean;
}

export function pairHostMounts(
  source: HostMount[],
  target: HostMount[],
): PairedHostMount[] {
  const out: PairedHostMount[] = [];
  for (const s of source) {
    if (NOT_DATA_HOST_PATH.test(s.hostPath)) continue;
    const hit = target.find((t) => t.mountPath === s.mountPath);
    if (!hit) continue;
    out.push({
      sourcePath: s.hostPath,
      targetPath: hit.hostPath,
      mountPath: s.mountPath,
      stackRelative: hit.stackRelative === true,
    });
  }
  return out;
}

/** Does this host volume name carry `alias` as its compose key? Both platforms
 *  prefix the project (`myapp_apidata`, `myapp-apidata`), neither renames the key. */
function volumeCarriesAlias(volumeName: string, alias: string): boolean {
  if (!alias) return false;
  if (volumeName === alias) return true;
  const tail = volumeName.slice(-(alias.length + 1));
  return tail === `_${alias}` || tail === `-${alias}`;
}

/** Docker names an anonymous volume with its own 64-hex id. Nobody chose it, so
 *  there is never a volume on the other side that corresponds to it. */
function isAnonymousVolume(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name);
}

/** Is `child` strictly inside `parent`? (`/a/b` is under `/a`, `/ab` is not.) */
function isUnderPath(child: string, parent: string): boolean {
  return parent !== "/" ? child.startsWith(`${parent}/`) : child !== "/";
}

/**
 * The volumes a Dokploy service DECLARES, for when there is no container to
 * inspect. Dokploy's own API still answers with the mounts it declared, so that is
 * the fallback.
 */
export function declaredSourceVolumes(input: {
  kind: string;
  appName: string;
  mounts?:
    | {
        type?: string | null;
        volumeName?: string | null;
        mountPath?: string | null;
      }[]
    | null;
  composeFile?: string | null;
}): NamedVolume[] {
  const out: NamedVolume[] = [];
  const seen = new Set<string>();
  const push = (name: string, mountPath: string) => {
    if (!name || !mountPath || seen.has(name)) return;
    seen.add(name);
    out.push({ name, mountPath: normalizePath(mountPath) });
  };

  for (const m of input.mounts ?? [])
    if (m?.type === "volume")
      push(m.volumeName?.trim() ?? "", m.mountPath?.trim() ?? "");

  if (input.kind === "compose" && input.appName.trim())
    for (const v of composeVolumeMounts(input.composeFile ?? ""))
      push(`${input.appName.trim()}_${v.name}`, v.mountPath);

  return out;
}

/** Paths an image declares that a STANDALONE never writes - the one unpairable
 *  volume on a plain Mongo, and not a loss to go looking for. */
const EMPTY_BY_DESIGN: Record<string, string> = {
  "/data/configdb":
    "MongoDB only writes it as part of a sharded cluster, so a standalone leaves it empty.",
};

/**
 * Match every source volume to the deplo volume that should receive it.
 */
export function pairVolumes(
  source: NamedVolume[],
  target: NamedVolume[],
  opts: { singleData?: boolean } = {},
): Mapped<VolumePair[]> {
  const notes: string[] = [];
  const pairs: VolumePair[] = [];
  const takenTarget = new Set<string>();
  const takenSource = new Set<string>();

  // The compose ALIAS first: the imported file is the source's own, so the key a
  // service mounts is the same word on both sides. Matching on the container path
  // alone crosses two services that both mount /data - silently, both ways.
  // Longest alias first, so `mydata` claims its own volume before `data` can.
  for (const t of [...target].sort(
    (a, b) => (b.alias?.length ?? 0) - (a.alias?.length ?? 0),
  )) {
    if (!t.alias) continue;
    const hit = source.find(
      (s) => !takenSource.has(s.name) && volumeCarriesAlias(s.name, t.alias!),
    );
    if (!hit) continue;
    takenSource.add(hit.name);
    takenTarget.add(t.name);
    pairs.push({
      sourceVolume: hit.name,
      targetVolume: t.name,
      mountPath: hit.mountPath,
      note: null,
    });
  }

  for (const s of source) {
    if (takenSource.has(s.name)) continue;
    const hit = target.find(
      (t) => !takenTarget.has(t.name) && t.mountPath === s.mountPath,
    );
    if (hit) {
      takenTarget.add(hit.name);
      takenSource.add(s.name);
      pairs.push({
        sourceVolume: s.name,
        targetVolume: hit.name,
        mountPath: s.mountPath,
        note: null,
      });
    }
  }

  if (
    pairs.length === 0 &&
    opts.singleData &&
    source.length === 1 &&
    target.length === 1
  ) {
    pairs.push({
      sourceVolume: source[0].name,
      targetVolume: target[0].name,
      mountPath: target[0].mountPath,
      note:
        `The data directory moved: {panel} mounted it at ${source[0].mountPath}, Deplo mounts ${target[0].mountPath}. ` +
        "The copy is still the right one - one data volume on each side, and Deplo pins the engine's data path to where it mounts it.",
    });
  }

  for (const s of source)
    // An anonymous volume left over is not news: the image asked for it, nobody named
    // it, and nothing on this side could ever correspond to it.
    if (
      !pairs.some((p) => p.sourceVolume === s.name) &&
      !isAnonymousVolume(s.name)
    )
      notes.push(
        `${s.name} is mounted at ${s.mountPath} on {panel}, but no volume of this app mounts that path.` +
          (EMPTY_BY_DESIGN[s.mountPath]
            ? ` ${EMPTY_BY_DESIGN[s.mountPath]}`
            : ""),
      );
  for (const t of target)
    if (!pairs.some((p) => p.targetVolume === t.name))
      notes.push(
        `${t.name} (${t.mountPath}) stays empty - nothing on {panel} is mounted there.`,
      );

  return { value: pairs, notes };
}

/**
 * The on-disk name of one of an app's volumes.
 */
export function deploVolumeName(
  slug: string,
  alias: string,
  managed: boolean,
): string {
  return managed ? `deplo-${slug}-${alias}` : `deplo-${slug}_${alias}`;
}

/** The data volume of a Deplo database, whose stack slug is its host name. */
export function deploDatabaseVolumeName(host: string): string {
  return `deplo-${host}_${host}-data`;
}

/**
 * Every container path the services of a compose file already mount, in either
 * shape. The renderer skips a Storage volume whose path the authored file
 * declares (`injectAppVolumes`), so the mapper has to know the same paths - or it
 * writes a row the deploy ignores and the data copy fills.
 */
export function composeMountPaths(
  compose: string | null | undefined,
): string[] {
  let doc: { services?: Record<string, { volumes?: unknown }> } | null;
  try {
    doc = yaml.load(compose ?? "") as typeof doc;
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const svc of Object.values(doc?.services ?? {})) {
    const mounts = svc?.volumes;
    if (!Array.isArray(mounts)) continue;
    for (const raw of mounts) {
      let dest: string | undefined;
      if (typeof raw === "string") {
        // Same rule as `containerPathOf`: one part is an ANONYMOUS volume, and
        // the path it names is mounted all the same.
        const parts = raw.split(":");
        dest = (parts.length > 1 ? parts[1] : parts[0])?.trim();
      } else if (raw && typeof raw === "object")
        dest = (raw as { target?: string }).target?.trim();
      if (dest) out.push(dest.replace(/\/+$/, ""));
    }
  }
  return out;
}

/** The service names a compose file declares, in the order it declares them. */
export function composeServices(compose: string | null | undefined): string[] {
  try {
    const doc = yaml.load(compose ?? "") as { services?: unknown } | null;
    const services = doc?.services;
    if (!services || typeof services !== "object" || Array.isArray(services))
      return [];
    return Object.keys(services as Record<string, unknown>);
  } catch {
    return [];
  }
}

/**
 * The ONE service a stack's traffic obviously belongs to: the only one that
 * publishes or exposes a port, or the only service there is. `null` the moment it
 * would be a guess - two candidates is a question for a person, not a default.
 */
export function composeServiceExposingPort(
  compose: string | null | undefined,
): string | null {
  let doc: {
    services?: Record<string, { ports?: unknown; expose?: unknown }>;
  } | null;
  try {
    doc = yaml.load(compose ?? "") as typeof doc;
  } catch {
    return null;
  }
  const services = Object.entries(doc?.services ?? {});
  if (services.length === 0) return null;
  if (services.length === 1) return services[0][0];
  const exposing = services.filter(
    ([, svc]) =>
      (Array.isArray(svc?.ports) && svc.ports.length > 0) ||
      (Array.isArray(svc?.expose) && svc.expose.length > 0),
  );
  return exposing.length === 1 ? exposing[0][0] : null;
}

/**
 * The volumes a compose file declares, with the path each is mounted at.
 */
export function composeVolumeMounts(compose: string): NamedVolume[] {
  let doc: {
    volumes?: unknown;
    services?: Record<string, { volumes?: unknown }>;
  } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return [];
  }
  const declared = doc?.volumes;
  if (!declared || typeof declared !== "object" || Array.isArray(declared))
    return [];
  const aliases = new Set(Object.keys(declared as Record<string, unknown>));
  const out: NamedVolume[] = [];
  const seen = new Set<string>();

  for (const svc of Object.values(doc?.services ?? {})) {
    const mounts = svc?.volumes;
    if (!Array.isArray(mounts)) continue;
    for (const raw of mounts) {
      let alias: string | undefined;
      let dest: string | undefined;
      if (typeof raw === "string") {
        const [src, target] = raw.split(":");
        alias = src?.trim();
        dest = target?.trim();
      } else if (raw && typeof raw === "object") {
        const m = raw as { type?: string; source?: string; target?: string };
        if (m.type && m.type !== "volume") continue;
        alias = m.source?.trim();
        dest = m.target?.trim();
      }
      if (!alias || !dest || !aliases.has(alias) || seen.has(alias)) continue;
      seen.add(alias);
      out.push({ name: alias, mountPath: normalizePath(dest) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Small shared helpers                                                */
/* ------------------------------------------------------------------ */

/** Cut a value quoted back at the user. No trailing marker: an ellipsis is
 *  banned from Deplo's copy, and the string is quoted so the cut is visible. */
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

/** Published host ports on an application, which deplo does not do for apps. */
export function portNotes(app: SourceApplication): string[] {
  const ports = app.ports ?? [];
  if (ports.length === 0) return [];
  const list = ports
    .map(
      (p) =>
        `${p.publishedPort}->${p.targetPort}${p.protocol ? `/${p.protocol}` : ""}`,
    )
    .join(", ");
  return [
    `Published host ports on {panel} (${list}). Deplo routes apps through its proxy instead - use a domain, or a compose stack if the port must be published.`,
  ];
}

/**
 * Dokploy keeps a health check in Swarm's own shape - `Test`, durations in
 * nanoseconds - and every field of it has a column here, so it comes across
 * instead of being reported as a setting with no equivalent.
 */
export function swarmHealthCheck(spec: unknown): HealthCheck | null {
  if (!spec || typeof spec !== "object") return null;
  const row = spec as Record<string, unknown>;
  const at = (key: string): unknown =>
    row[key] ?? row[key[0].toLowerCase() + key.slice(1)];
  const test = Array.isArray(at("Test"))
    ? (at("Test") as unknown[]).map(String)
    : [];
  if (test.length === 0 || test[0] === "NONE") return null;
  const command = (
    test[0] === "CMD" || test[0] === "CMD-SHELL" ? test.slice(1) : test
  )
    .join(" ")
    .trim();
  if (!command) return null;
  const seconds = (key: string, fallback: number): number => {
    const n = Number(at(key));
    return Number.isFinite(n) && n > 0
      ? Math.max(1, Math.round(n / 1e9))
      : fallback;
  };
  const intervalS = seconds("Interval", HEALTH_CHECK_DEFAULTS.intervalS);
  const timeoutS = seconds("Timeout", HEALTH_CHECK_DEFAULTS.timeoutS);
  const retries = Number(at("Retries"));
  return {
    type: "command",
    path: null,
    port: null,
    command,
    intervalS,
    // Deplo refuses a check still running when the next one is due.
    timeoutS: timeoutS < intervalS ? timeoutS : Math.max(1, intervalS - 1),
    retries:
      Number.isFinite(retries) && retries > 0
        ? Math.round(retries)
        : HEALTH_CHECK_DEFAULTS.retries,
    startPeriodS: seconds("StartPeriod", HEALTH_CHECK_DEFAULTS.startPeriodS),
  };
}

/** Everything else on a Dokploy service with no deplo column at all. */
export function unsupportedNotes(app: SourceApplication): string[] {
  const notes: string[] = [];
  if ((app.redirects ?? []).length > 0)
    notes.push(
      `${app.redirects!.length} redirect rule(s) on {panel} - Deplo has no redirect list, use a domain per host.`,
    );
  // Swarm's own service spec.
  const swarm = (
    [
      ["healthCheckSwarm", "a health check"],
      ["placementSwarm", "placement constraints"],
      ["labelsSwarm", "service labels"],
      ["ulimitsSwarm", "ulimits"],
    ] as const
  ).filter(
    ([key]) =>
      hasSwarmValue(app[key]) &&
      // The health check is imported now, so it is not a loss to report.
      !(key === "healthCheckSwarm" && swarmHealthCheck(app[key])),
  );
  if (swarm.length > 0)
    notes.push(
      `Swarm settings on {panel} (${swarm.map(([, label]) => label).join(", ")}) have no equivalent here - Deplo runs one container per app through compose.`,
    );
  return notes;
}

/** A swarm column Dokploy actually filled in (it stores `null` or `{}` otherwise). */
function hasSwarmValue(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "" && v.trim() !== "{}";
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return false;
}

/* ------------------------------------------------------------------ */
/* A compose service that is really one app                            */
/* ------------------------------------------------------------------ */

/** What a git-backed compose turns out to be, when it is an app in disguise. */
export interface ComposeRepoApp {
  /** The one service's key, for the note that explains what happened. */
  service: string;
  /** Path to a Dockerfile relative to the repo, when the build names one. */
  dockerfilePath?: string;
  /** The build context, when it is not the repo root. */
  dockerContextPath?: string;
  /** `--target` on a multi-stage build. */
  dockerBuildStage?: string;
}

/**
 * Is this compose file one service that BUILDS FROM ITS OWN REPOSITORY?
 */
export function composeAsRepoApp(compose: string): ComposeRepoApp | null {
  let doc: {
    services?: Record<
      string,
      {
        image?: unknown;
        build?: unknown;
        depends_on?: unknown;
      }
    >;
  } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return null;
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return null;
  const keys = Object.keys(services);
  if (keys.length !== 1) return null;

  const key = keys[0]!;
  const svc = services[key];
  if (!svc || typeof svc !== "object") return null;
  // An `image:` next to a `build:` means the build has a name to be pushed
  // under, and Deplo names its own images - but an image ALONE is a stack that
  // pulls, which is a compose app and stays one.
  if (!svc.build) return null;
  if (svc.depends_on) return null;

  const out: ComposeRepoApp = { service: key };
  // `build: .` is the whole block; the long form carries the paths.
  if (typeof svc.build === "object" && !Array.isArray(svc.build)) {
    const b = svc.build as Record<string, unknown>;
    const str = (v: unknown) =>
      typeof v === "string" && v.trim() ? v.trim() : undefined;
    const ctx = str(b.context);
    // "." is the repo root, which is Deplo's default - saying it again would put
    // a value in the build settings that reads as a choice somebody made.
    if (ctx && ctx !== ".") out.dockerContextPath = ctx;
    out.dockerfilePath = str(b.dockerfile);
    out.dockerBuildStage = str(b.target);
  }
  return out;
}

/**
 * The services of a compose file that build from source, by name. A stack Deplo
 * keeps as a stack has no repository behind it, so every one of these is a service
 * that cannot build here.
 */
export function composeBuildServices(compose: string): string[] {
  let doc: { services?: Record<string, { build?: unknown }> } | null;
  try {
    doc = yaml.load(compose) as typeof doc;
  } catch {
    return [];
  }
  const services = doc?.services;
  if (!services || typeof services !== "object") return [];
  return Object.entries(services)
    .filter(([, s]) => s && typeof s === "object" && s.build)
    .map(([k]) => k);
}
