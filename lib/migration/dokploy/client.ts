import type { SourceCredential } from "../source";
import {
  REQUEST_TIMEOUT_MS,
  panelSaid,
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

// DOKPLOY_DB_KINDS - which of Dokploy's per-engine tables a database row came from.
export const DOKPLOY_DB_KINDS = [
  "postgres",
  "mysql",
  "mariadb",
  "mongo",
  "redis",
  "libsql",
] as const;
export type DokployDbKind = (typeof DOKPLOY_DB_KINDS)[number];

const DOKPLOY_PANEL: PanelIdentity = { name: "Dokploy", portHint: ":3000" };

// Keys a panel has accepted at least once in this process.
const accepted = new Set<string>();
const acceptedKey = (c: SourceCredential) => `${c.baseUrl}|${c.apiKey}`;

// __resetAcceptedKeysForTest - tests reuse one key across a wrong-key case and a working one.
export function __resetAcceptedKeysForTest(): void {
  accepted.clear();
}

// A key minted outside Dokploy's own dialog is born at 10 requests a DAY. Measured on
// v0.30.5: a key at its limit answers 401 like a wrong key, so a 401 on a key accepted
// moments ago is the limit or a revocation, never a typo.
async function requestFailed(
  res: Response,
  procedure: string,
  c: SourceCredential,
): Promise<Error> {
  const detail = panelSaid(await res.text().catch(() => ""));
  if (
    res.status === 429 ||
    (res.status === 401 && accepted.has(acceptedKey(c)))
  )
    return new Error(
      `Dokploy stopped accepting this API key on ${procedure} (${res.status}). It was accepted moments ago, so it has hit its rate limit or was revoked: open it in Dokploy under Settings, Profile, API/CLI, raise or disable its rate limit, and run the import again.`,
    );
  return new Error(
    `Dokploy request failed (${res.status}) on ${procedure}` +
      (detail ? `: ${detail}` : ""),
  );
}

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
  if (!res.ok) throw await requestFailed(res, procedure, c);
  accepted.add(acceptedKey(c));
  return (await res.json()) as T;
}

// The only writes this client ever makes are the `*.stop`/`*.start` calls of a
// cutover, so "the source instance is only read" stays true of everything else.
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
  if (!res.ok) throw await requestFailed(res, procedure, c);
  accepted.add(acceptedKey(c));
  return (await res.json().catch(() => null)) as T;
}

const SERVICE_KEYS = ["applications", "compose", ...DOKPLOY_DB_KINDS] as const;

// A pre-environments Dokploy carries the services directly on the project row.
function hasLooseServices(p: SourceProject): boolean {
  return SERVICE_KEYS.some((k) => {
    const v = p[k as keyof SourceProject];
    return Array.isArray(v) && v.length > 0;
  });
}

// listProjects - every project of the key's organization, with environments and services.
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

// getEnvironment - the variable blob `project.all` never carries.
export async function getEnvironment(
  c: SourceCredential,
  environmentId: string,
): Promise<SourceEnvironment | null> {
  try {
    return await get<SourceEnvironment>(c, "environment.one", {
      environmentId,
    });
  } catch {
    // An older Dokploy has no environments, and a member key can be refused here.
    return null;
  }
}

// getApplication - one application WITH its domains, mounts, ports and basic-auth users.
export function getApplication(
  c: SourceCredential,
  applicationId: string,
): Promise<SourceApplication> {
  return get<SourceApplication>(c, "application.one", { applicationId });
}

// getCompose - one compose stack WITH its domains and mounts.
export function getCompose(
  c: SourceCredential,
  composeId: string,
): Promise<SourceCompose> {
  return get<SourceCompose>(c, "compose.one", { composeId });
}

// getDatabase - one database WITH its mounts; `kind` picks the table and the id parameter.
export function getDatabase(
  c: SourceCredential,
  kind: DokployDbKind,
  id: string,
): Promise<SourceDatabase> {
  return get<SourceDatabase>(c, `${kind}.one`, { [`${kind}Id`]: id });
}

// getService - the detail call for any kind of service, picked by kind.
export function getService(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<SourceApplication | SourceCompose | SourceDatabase> {
  if (kind === "application") return getApplication(c, id);
  if (kind === "compose") return getCompose(c, id);
  return getDatabase(c, kind as DokployDbKind, id);
}

// serviceDisplayName - from the detail row, however it is shaped.
export function serviceDisplayName(
  detail: { name?: string | null } | null | undefined,
  fallback: string,
): string {
  const name = detail?.name?.trim();
  return name || fallback;
}

function composeOrNull(body: string): string | null {
  const yaml = body.trim();
  return yaml && /^\s*services\s*:/m.test(yaml) ? yaml : null;
}

// Deplo holds compose YAML inline, so a repo-backed stack has nothing to import without this.
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

// readTraefikConfig - best-effort: an older Dokploy has no such procedure, and a
// file that will not come is a report line short, not a failed import.
export async function readTraefikConfig(
  c: SourceCredential,
  applicationId: string,
): Promise<string | null> {
  try {
    const body = await get<unknown>(c, "application.readTraefikConfig", {
      applicationId,
    });
    return typeof body === "string" && body.trim() ? body : null;
  } catch {
    return null;
  }
}

// `destination.all` hands the credentials over in the clear (measured on v0.30.5), unlike a registry's.
export interface DokployDestination {
  destinationId?: string | null;
  name?: string | null;
  endpoint?: string | null;
  bucket?: string | null;
  region?: string | null;
  accessKey?: string | null;
  secretAccessKey?: string | null;
}

// DokployVolumeBackup - one `volumeBackups.list` row (Dokploy 0.30+).
export interface DokployVolumeBackup {
  volumeBackupId?: string | null;
  name?: string | null;
  volumeName?: string | null;
  cronExpression?: string | null;
  destinationId?: string | null;
  destination?: { name?: string | null } | null;
  keepLatestCount?: number | null;
  enabled?: boolean | null;
  serviceName?: string | null;
}

// Best-effort: an older panel has no such route.
export async function listVolumeBackups(
  c: SourceCredential,
  id: string,
  type: "application" | "compose",
): Promise<DokployVolumeBackup[]> {
  try {
    const rows = await get<DokployVolumeBackup[] | null>(
      c,
      "volumeBackups.list",
      {
        id,
        volumeBackupType: type,
      },
    );
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

// Best-effort: a key that may not read them, or a Dokploy without the procedure, is a report line short.
export async function listDestinations(
  c: SourceCredential,
): Promise<DokployDestination[]> {
  try {
    const rows = await get<DokployDestination[] | null>(c, "destination.all");
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

// `serverId: null` on a service means Dokploy's own host, which has no row here.
export async function listServers(
  c: SourceCredential,
): Promise<SourceServer[]> {
  const rows = await get<SourceServer[]>(c, "server.all");
  return Array.isArray(rows) ? rows : [];
}

// listMembers - everyone in the key's organization, for the registration-link step.
export async function listMembers(
  c: SourceCredential,
): Promise<SourceMember[]> {
  const rows = await get<SourceMember[]>(c, "user.all");
  return Array.isArray(rows) ? rows : [];
}

// A better-auth organization row, of which only these three are read.
interface DokployOrganization {
  id?: string | null;
  name?: string | null;
  // A data URI from Dokploy's own uploader, or a typed address.
  logo?: string | null;
}

// Best-effort: an older instance has no such procedure, and not knowing must not stop an import.
export async function activeOrganization(c: SourceCredential): Promise<{
  id: string | null;
  name: string | null;
}> {
  try {
    const org = await get<DokployOrganization | null>(c, "organization.active");
    return { id: org?.id?.trim() || null, name: org?.name?.trim() || null };
  } catch {
    return { id: null, name: null };
  }
}

// Every organization the key's OWNER belongs to - a key names exactly one of them;
// null when the panel will not say, which an older one will not.
export async function listOrganizations(
  c: SourceCredential,
): Promise<{ id: string; name: string }[] | null> {
  try {
    const rows = await get<DokployOrganization[] | null>(c, "organization.all");
    if (!Array.isArray(rows)) return null;
    return rows
      .map((o) => ({ id: o?.id?.trim() || "", name: o?.name?.trim() || "" }))
      .filter((o) => o.id !== "");
  } catch {
    return null;
  }
}

// DokployContainer - one running container, as Dokploy's `docker ps` wrapper parses it.
export interface DokployContainer {
  containerId: string;
  name: string;
  state: string;
}

// DokployRuntime - how a Dokploy service's containers are found.
export type DokployRuntime = "swarm" | "standalone";

// Without `serverId` Dokploy looks on its OWN host: a service on a remote server
// used to read as stopped, and a git app there as "cannot tell what its data is".
export async function listAppContainers(
  c: SourceCredential,
  appName: string,
  type: DokployRuntime,
  serverId?: string,
): Promise<DokployContainer[]> {
  const rows = await get<DokployContainer[] | null>(
    c,
    "docker.getContainersByAppLabel",
    { appName, type, serverId: serverId || undefined },
  );
  return Array.isArray(rows) ? rows : [];
}

// A network the PANEL manages: how a stack or app joins one without the compose file naming it.
export interface DokployNetwork {
  networkId: string;
  name: string;
}

// Empty on a Dokploy too old to have them: the endpoint is missing, not the import.
export async function listNetworks(
  c: SourceCredential,
): Promise<DokployNetwork[]> {
  const rows = await get<DokployNetwork[] | null>(c, "network.all").catch(
    () => null,
  );
  return Array.isArray(rows) ? rows : [];
}

// DokployInspect - what `docker inspect` says, reduced to what a data move reads.
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

// `docker.getConfig` is literally `docker inspect <id>` on the source host.
export function inspectContainer(
  c: SourceCredential,
  containerId: string,
  serverId?: string,
): Promise<DokployInspect> {
  return get<DokployInspect>(c, "docker.getConfig", {
    containerId,
    serverId: serverId || undefined,
  });
}

const STOP_PROCEDURE: Record<string, string> = {
  application: "application.stop",
  compose: "compose.stop",
  postgres: "postgres.stop",
  mysql: "mysql.stop",
  mariadb: "mariadb.stop",
  mongo: "mongo.stop",
  redis: "redis.stop",
};

// stopService - stops on the SOURCE instance and leaves it stopped; the UI says so first.
export async function stopService(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<void> {
  const procedure = STOP_PROCEDURE[kind];
  if (!procedure) throw new Error(`Deplo cannot stop a ${kind} on Dokploy.`);
  await post(c, procedure, { [`${kind}Id`]: id });
}

// The only reason Deplo starts something on a platform it is migrating away from: a takeover backed out.
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

// listSchedules - the cron jobs attached to one service; best-effort, as above.
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
