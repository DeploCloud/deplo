/**
 * Read-only client for a Dokploy instance's HTTP API.
 */

import type { SourceCredential } from "../source";
import type {
  SourceApplication,
  SourceCompose,
  SourceDatabase,
  SourceEnvironment,
  SourceMember,
  SourceProject,
  SourceSchedule,
  SourceServer,
} from "../model";

/** Which of Dokploy's per-engine tables a database row came from. */
export const DOKPLOY_DB_KINDS = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "libsql",
] as const;
export type DokployDbKind = (typeof DOKPLOY_DB_KINDS)[number];

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

/**
 * How long one Dokploy call may take.
 */
const REQUEST_TIMEOUT_MS = 15_000;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let doFetch: FetchLike = (input, init) => fetch(input, init);

/** Swap the transport in tests (the import suite drives recorded fixtures). */
export function __setDokployFetchForTest(fn: FetchLike): void {
  doFetch = fn;
}

export function __resetDokployFetchForTest(): void {
  doFetch = (input, init) => fetch(input, init);
}

/**
 * A transport failure, said out loud. All three read the same otherwise, so the
 * user is left guessing on the one screen where guessing costs the most.
 */
/**
 * An https URL whose host is a bare IP. Deliberately not "any IP": `http://` on an
 * IP is the everyday same-machine case, and the placeholder on that very field
 * suggests one.
 */
function isBareIpHttps(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (u.protocol !== "https:") return false;
    // `hostname` strips the brackets an IPv6 literal is written with.
    return (
      /^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) || u.hostname.includes(":")
    );
  } catch {
    return false;
  }
}

export function describeDokployTransportError(
  err: unknown,
  baseUrl: string,
): string {
  const at = `at ${baseUrl}`;
  if (
    err instanceof Error &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  )
    return `Dokploy did not answer within ${REQUEST_TIMEOUT_MS / 1000} seconds ${at}. It may be slow, or something on the way is dropping the connection.`;

  const cause =
    err instanceof Error
      ? (err.cause as { code?: string } | undefined)
      : undefined;
  const code = typeof cause?.code === "string" ? cause.code : "";
  const message = err instanceof Error ? err.message : String(err);

  switch (code) {
    case "ECONNREFUSED":
      return `Nothing is listening ${at}. Check the port - Dokploy serves :3000 unless it is behind a proxy.`;
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return `That address does not resolve (${baseUrl}). Check the hostname.`;
    case "ECONNRESET":
    case "EPIPE":
      return `The connection to ${baseUrl} was cut before Dokploy answered. If Dokploy is on plain http there, use http:// rather than https://.`;
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "ETIMEDOUT":
    case "UND_ERR_CONNECT_TIMEOUT":
      return `Could not reach ${baseUrl} - no route to it from this machine. If it is on a private network, an instance admin has to allow that.`;
    case "CERT_HAS_EXPIRED":
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      // The trap, named.
      return isBareIpHttps(baseUrl)
        ? `${baseUrl} answered with a certificate this machine does not trust (${code}) - which is what an IP address gets, because the certificate is issued for the panel's NAME. Put the address you open Dokploy on in your browser here. The machine's own address is asked for at the next step, and it is not this field.`
        : `The https certificate ${at} is not one this machine trusts (${code}).`;
    case "ERR_SSL_WRONG_VERSION_NUMBER":
    case "EPROTO":
      return `${baseUrl} answered, but not over https. Try http:// instead.`;
    default:
      return `Could not reach Dokploy ${at}${code ? ` (${code})` : ""}: ${message}.`;
  }
}

/** Every call goes out through here so no caller can leak a bare "fetch failed". */
async function send(
  baseUrl: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await doFetch(url, init);
  } catch (e) {
    throw new Error(describeDokployTransportError(e, baseUrl));
  }
}

/** Origin with no trailing slash and no trailing `/api`, however it was typed. */
export function normalizeDokployBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  const u = new URL(withScheme);
  if (u.username || u.password)
    throw new Error("Put the key in the API key field, not in the address.");
  const path = u.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
  return `${u.origin}${path}`;
}

/**
 * One GET against Dokploy, with a readable failure.
 */
async function get<T>(
  c: SourceCredential,
  procedure: string,
  params: Record<string, string | undefined> = {},
): Promise<T> {
  const url = new URL(`${c.baseUrl}/api/${procedure}`);
  for (const [k, v] of Object.entries(params))
    if (v !== undefined) url.searchParams.set(k, v);

  const res = await send(c.baseUrl, url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent": "deplo",
      "x-api-key": c.apiKey,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get("location") ?? "";
    throw new Error(
      `Dokploy answered with a redirect (${res.status})` +
        (to ? ` to ${to.slice(0, 200)}` : "") +
        ". Deplo does not follow redirects here. Point this at the address that answers directly.",
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300).trim();
    throw new Error(
      `Dokploy request failed (${res.status}) on ${procedure}` +
        (detail ? `: ${detail}` : ""),
    );
  }
  return (await res.json()) as T;
}

/**
 * One POST against Dokploy. The ONLY writes this client ever makes are the
 * `*.stop` calls of a data cutover - deliberately, so "the source instance is
 * only read" stays true of everything else and it keeps working as the rollback.
 */
async function post<T>(
  c: SourceCredential,
  procedure: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await send(c.baseUrl, `${c.baseUrl}/api/${procedure}`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "User-Agent": "deplo",
      "x-api-key": c.apiKey,
    },
    body: JSON.stringify(body),
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300).trim();
    throw new Error(
      `Dokploy request failed (${res.status}) on ${procedure}` +
        (detail ? `: ${detail}` : ""),
    );
  }
  return (await res.json().catch(() => null)) as T;
}

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

const SERVICE_KEYS = ["applications", "compose", ...DOKPLOY_DB_KINDS] as const;

/** True when a project row carries services directly (pre-environments Dokploy). */
function hasLooseServices(p: SourceProject): boolean {
  return SERVICE_KEYS.some((k) => {
    const v = p[k as keyof SourceProject];
    return Array.isArray(v) && v.length > 0;
  });
}

/**
 * Every project of the key's organization, with environments and their services.
 */
export async function listProjects(
  c: SourceCredential,
): Promise<SourceProject[]> {
  const projects = await get<SourceProject[]>(c, "project.all");
  if (!Array.isArray(projects)) return [];
  return projects.map((p) => {
    const envs = Array.isArray(p.environments) ? p.environments : [];
    if (envs.length > 0 || !hasLooseServices(p))
      return { ...p, environments: envs };
    const synthetic: SourceEnvironment = {
      environmentId: `legacy-${p.projectId}`,
      name: "production",
      isDefault: true,
      env: "",
      applications: p.applications ?? [],
      compose: p.compose ?? [],
      postgres: p.postgres ?? [],
      mysql: p.mysql ?? [],
      mariadb: p.mariadb ?? [],
      mongo: p.mongo ?? [],
      redis: p.redis ?? [],
      libsql: p.libsql ?? [],
    };
    return { ...p, environments: [synthetic] };
  });
}

/**
 * One environment's own row, for the variable blob `project.all` never carries.
 */
export async function getEnvironment(
  c: SourceCredential,
  environmentId: string,
): Promise<SourceEnvironment | null> {
  try {
    return await get<SourceEnvironment>(c, "environment.one", {
      environmentId,
    });
  } catch {
    // An older Dokploy has no environments at all (the tree is synthesised), and
    // a member key can be refused here. Neither is worth failing an import over.
    return null;
  }
}

/** One application WITH its domains, mounts, ports and basic-auth users. */
export function getApplication(
  c: SourceCredential,
  applicationId: string,
): Promise<SourceApplication> {
  return get<SourceApplication>(c, "application.one", { applicationId });
}

/** One compose stack WITH its domains and mounts. */
export function getCompose(
  c: SourceCredential,
  composeId: string,
): Promise<SourceCompose> {
  return get<SourceCompose>(c, "compose.one", { composeId });
}

/** One database WITH its mounts. `kind` picks the table and the id parameter. */
export function getDatabase(
  c: SourceCredential,
  kind: DokployDbKind,
  id: string,
): Promise<SourceDatabase> {
  return get<SourceDatabase>(c, `${kind}.one`, { [`${kind}Id`]: id });
}

/**
 * The detail call for any kind of service, picked by kind.
 */
export function getService(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<SourceApplication | SourceCompose | SourceDatabase> {
  if (kind === "application") return getApplication(c, id);
  if (kind === "compose") return getCompose(c, id);
  return getDatabase(c, kind as DokployDbKind, id);
}

/** The display name of a service, from its detail row, however it is shaped. */
export function serviceDisplayName(
  detail: { name?: string | null } | null | undefined,
  fallback: string,
): string {
  const name = detail?.name?.trim();
  return name || fallback;
}

/**
 * A compose body only counts when it declares services.
 */
function composeOrNull(body: string): string | null {
  const yaml = body.trim();
  return yaml && /^\s*services\s*:/m.test(yaml) ? yaml : null;
}

/**
 * The compose file Dokploy would actually deploy, for a stack whose YAML lives in
 * a git repo rather than in the database. deplo holds compose YAML inline, so a
 * repo-backed stack has nothing to import without this.
 */
export async function getConvertedCompose(
  c: SourceCredential,
  composeId: string,
): Promise<string | null> {
  try {
    const body = await get<unknown>(c, "compose.getConvertedCompose", {
      composeId,
    });
    if (typeof body === "string") return composeOrNull(body);
    if (body && typeof body === "object") {
      for (const v of Object.values(body as Record<string, unknown>)) {
        const yaml = typeof v === "string" ? composeOrNull(v) : null;
        if (yaml) return yaml;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** The fleet the source instance deploys to. `serverId: null` on a service means
 *  Dokploy's own host, which has no row here. */
export async function listServers(
  c: SourceCredential,
): Promise<SourceServer[]> {
  const rows = await get<SourceServer[]>(c, "server.all");
  return Array.isArray(rows) ? rows : [];
}

/** Everyone in the key's organization, for the registration-link step. */
export async function listMembers(
  c: SourceCredential,
): Promise<SourceMember[]> {
  const rows = await get<SourceMember[]>(c, "user.all");
  return Array.isArray(rows) ? rows : [];
}

/**
 * The name of the organization this key reads, so the wizard can say what it is
 * about to pull. Best-effort: an older instance has no such procedure, and not
 * knowing the name must not stop an import.
 */
export async function activeOrganizationName(
  c: SourceCredential,
): Promise<string | null> {
  try {
    const org = await get<{ name?: string | null } | null>(
      c,
      "organization.active",
    );
    const name = org?.name?.trim();
    return name ? name : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* The data cutover                                                    */
/* ------------------------------------------------------------------ */

/** One running container of a service, as Dokploy's `docker ps` wrapper parses it. */
export interface DokployContainer {
  containerId: string;
  name: string;
  state: string;
}

/**
 * How a Dokploy service's containers are found.
 */
export type DokployRuntime = "swarm" | "standalone";

/** The containers of one service, by its `appName`. */
export async function listAppContainers(
  c: SourceCredential,
  appName: string,
  type: DokployRuntime,
): Promise<DokployContainer[]> {
  const rows = await get<DokployContainer[] | null>(
    c,
    "docker.getContainersByAppLabel",
    { appName, type },
  );
  return Array.isArray(rows) ? rows : [];
}

/** What `docker inspect` says, reduced to the two things a data move reads. */
export interface DokployInspect {
  Name?: string;
  State?: { Running?: boolean; Status?: string };
  Mounts?: {
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
  }[];
}

/**
 * `docker inspect <id>` on the source host, through Dokploy's own API
 * (`docker.getConfig` is literally that command).
 */
export function inspectContainer(
  c: SourceCredential,
  containerId: string,
): Promise<DokployInspect> {
  return get<DokployInspect>(c, "docker.getConfig", { containerId });
}

/** Which procedure stops one kind of service, and what it calls its id. */
const STOP_PROCEDURE: Record<string, string> = {
  application: "application.stop",
  compose: "compose.stop",
  postgres: "postgres.stop",
  mysql: "mysql.stop",
  mariadb: "mariadb.stop",
  mongo: "mongo.stop",
  redis: "redis.stop",
};

/**
 * Stop a service on the SOURCE instance, and leave it stopped. The UI says so
 * before the button is pressed.
 */
export async function stopService(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<void> {
  const procedure = STOP_PROCEDURE[kind];
  if (!procedure) throw new Error(`Deplo cannot stop a ${kind} on Dokploy.`);
  await post(c, procedure, { [`${kind}Id`]: id });
}

/** The cron jobs attached to one service. Best-effort, same reasoning as above. */
export async function listSchedules(
  c: SourceCredential,
  scheduleType: string,
  id: string,
): Promise<SourceSchedule[]> {
  try {
    const rows = await get<SourceSchedule[]>(c, "schedule.list", {
      scheduleType,
      id,
    });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}
