/**
 * Read-only client for a Dokploy instance's HTTP API.
 */

import type { SourceCredential } from "../source";
import {
  REQUEST_TIMEOUT_MS,
  refuseRedirect,
  sendRequest,
  type PanelIdentity,
} from "../transport";
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

const DOKPLOY_PANEL: PanelIdentity = { name: "Dokploy", portHint: ":3000" };

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

  const res = await sendRequest(
    c.baseUrl,
    url.toString(),
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "deplo",
        "x-api-key": c.apiKey,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
    DOKPLOY_PANEL,
  );

  refuseRedirect(res, DOKPLOY_PANEL);
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
  const res = await sendRequest(
    c.baseUrl,
    `${c.baseUrl}/api/${procedure}`,
    {
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
    },
    DOKPLOY_PANEL,
  );
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
 * a git repo rather than in the database. Deplo holds compose YAML inline, so a
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

/** A network the PANEL manages, which is how a stack or an app joins one without
 *  the compose file ever naming it (`compose.serviceNetworks`, `app.networkIds`). */
export interface DokployNetwork {
  networkId: string;
  name: string;
}

/** The panel's own networks, by id. Empty on a Dokploy too old to have them:
 *  the endpoint is missing, not the import. */
export async function listNetworks(
  c: SourceCredential,
): Promise<DokployNetwork[]> {
  const rows = await get<DokployNetwork[] | null>(c, "network.all").catch(
    () => null,
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

/**
 * Undo that stop - the only reason Deplo ever starts something on a platform it
 * is migrating away from is an operator backing out of a takeover.
 */
export async function startService(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<void> {
  const procedure = STOP_PROCEDURE[kind];
  if (!procedure) throw new Error(`Deplo cannot start a ${kind} on Dokploy.`);
  await post(c, procedure.replace(/\.stop$/, ".start"), {
    [`${kind}Id`]: id,
  });
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
