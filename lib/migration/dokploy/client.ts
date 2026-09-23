import { createHash } from "node:crypto";

import { sweepStale } from "../../stale-sweep";
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

// A key at its rate limit answers 401 exactly like a wrong key, so only one accepted moments ago proves the limit.
// Hashed, so the process never holds a raw key; an hour without a success forgets it.
const accepted = new Map<string, number>();
const ACCEPTED_TTL_MS = 60 * 60 * 1000;
const acceptedKey = (c: SourceCredential) =>
  createHash("sha256").update(`${c.baseUrl}|${c.apiKey}`).digest("hex");
const wasAccepted = (c: SourceCredential) =>
  Date.now() - (accepted.get(acceptedKey(c)) ?? 0) < ACCEPTED_TTL_MS;
function markAccepted(c: SourceCredential): void {
  accepted.set(acceptedKey(c), Date.now());
  sweepStale(accepted, (at) => at, ACCEPTED_TTL_MS, Date.now(), 0);
}

export function __acceptedKeysForTest(): string[] {
  return [...accepted.keys()];
}

export function __resetAcceptedKeysForTest(): void {
  accepted.clear();
}

async function requestFailed(
  res: Response,
  procedure: string,
  c: SourceCredential,
): Promise<Error> {
  const detail = panelSaid(await res.text().catch(() => ""));
  if (res.status === 429 || (res.status === 401 && wasAccepted(c)))
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
  markAccepted(c);
  return (await res.json()) as T;
}

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
  markAccepted(c);
  return (await res.json().catch(() => null)) as T;
}

const SERVICE_KEYS = ["applications", "compose", ...DOKPLOY_DB_KINDS] as const;

function hasLooseServices(p: SourceProject): boolean {
  return SERVICE_KEYS.some((k) => {
    const v = p[k as keyof SourceProject];
    return Array.isArray(v) && v.length > 0;
  });
}

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

export async function getEnvironment(
  c: SourceCredential,
  environmentId: string,
): Promise<SourceEnvironment | null> {
  try {
    return await get<SourceEnvironment>(c, "environment.one", {
      environmentId,
    });
  } catch {
    return null;
  }
}

export function getApplication(
  c: SourceCredential,
  applicationId: string,
): Promise<SourceApplication> {
  return get<SourceApplication>(c, "application.one", { applicationId });
}

export function getCompose(
  c: SourceCredential,
  composeId: string,
): Promise<SourceCompose> {
  return get<SourceCompose>(c, "compose.one", { composeId });
}

export function getDatabase(
  c: SourceCredential,
  kind: DokployDbKind,
  id: string,
): Promise<SourceDatabase> {
  return get<SourceDatabase>(c, `${kind}.one`, { [`${kind}Id`]: id });
}

export function getService(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<SourceApplication | SourceCompose | SourceDatabase> {
  if (kind === "application") return getApplication(c, id);
  if (kind === "compose") return getCompose(c, id);
  return getDatabase(c, kind as DokployDbKind, id);
}

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

export interface DokployDestination {
  destinationId?: string | null;
  name?: string | null;
  endpoint?: string | null;
  bucket?: string | null;
  region?: string | null;
  accessKey?: string | null;
  secretAccessKey?: string | null;
}

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

export async function listServers(
  c: SourceCredential,
): Promise<SourceServer[]> {
  const rows = await get<SourceServer[]>(c, "server.all");
  return Array.isArray(rows) ? rows : [];
}

export async function listMembers(
  c: SourceCredential,
): Promise<SourceMember[]> {
  const rows = await get<SourceMember[]>(c, "user.all");
  return Array.isArray(rows) ? rows : [];
}

interface DokployOrganization {
  id?: string | null;
  name?: string | null;
  logo?: string | null;
}

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

export interface DokployContainer {
  containerId: string;
  name: string;
  state: string;
}

export type DokployRuntime = "swarm" | "standalone";

// Without serverId Dokploy looks on its OWN host: every service on a remote server used to read as stopped.
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

export interface DokployNetwork {
  networkId: string;
  name: string;
}

export async function listNetworks(
  c: SourceCredential,
): Promise<DokployNetwork[]> {
  const rows = await get<DokployNetwork[] | null>(c, "network.all").catch(
    () => null,
  );
  return Array.isArray(rows) ? rows : [];
}

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

export async function stopService(
  c: SourceCredential,
  kind: string,
  id: string,
): Promise<void> {
  const procedure = STOP_PROCEDURE[kind];
  if (!procedure) throw new Error(`Deplo cannot stop a ${kind} on Dokploy.`);
  await post(c, procedure, { [`${kind}Id`]: id });
}

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
