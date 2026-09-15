import "server-only";

import { eq } from "drizzle-orm";
import { hostname } from "node:os";

import type { AppStatus } from "../types/app";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import { requireActiveTeamId, requireInstanceAdmin } from "../membership";
import { getCurrentUser } from "../auth/current-user";
import { isDeploHostServer } from "../deploy/domains";
import { recordActivity } from "./activity";
import { assertNotMigrationSource, getServerById } from "./servers/roster";
import { stopStackOn, startStackOn } from "./volume-migration";

export type ServerHostInfo = {
  cpuModel: string;
  cpuCores: number;
  cpuThreads: number;
  memTotalBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  osPretty: string;
  kernel: string;
  arch: string;
  dockerVersion: string;
  dockerRootDir: string;
  uptimeSec: number;
  timezone: string;
  timeUnixMs: number;
  controlPlaneTimeUnixMs: number;
  utcOffsetMinutes: number;
  canRestartControlPlane: boolean;
};

export type RestartedWorkload = {
  kind: "app" | "database";
  name: string;
  error: string | null;
};

export type ServerRestartReport = {
  restarted: number;
  skipped: number;
  failures: RestartedWorkload[];
};

export async function serverHostInfo(id: string): Promise<ServerHostInfo> {
  await requireInstanceAdmin();
  await requireActiveTeamId();
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const { fetchHostInfo } = await import("../infra/agent-client/host-ops");
  const info = await fetchHostInfo(id, {
    controlPlaneHint: controlPlaneHint(),
  });
  return toHostInfo(info);
}

export async function setServerTimezone(
  id: string,
  timezone: string,
): Promise<ServerHostInfo> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const tz = canonicalTimezone(timezone);
  if (!tz)
    throw new Error(
      `${timezone.trim() || "That"} is not a timezone. Pick one from the list, like "Europe/Rome".`,
    );

  const { setHostTimezone } = await import("../infra/agent-client/host-ops");
  const info = await setHostTimezone(id, tz, {
    controlPlaneHint: controlPlaneHint(),
  });
  await recordActivity(
    "server",
    `Set the timezone on ${server.name} to ${tz}`,
    user.name,
    null,
    teamId,
  );
  return toHostInfo(info);
}

export function canonicalTimezone(input: string): string | null {
  const tz = input.trim();
  if (!tz) return null;
  let resolved: string;
  try {
    resolved = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
  return /^[+-]/.test(resolved) ? null : resolved;
}

export async function restartServerWorkloads(
  id: string,
): Promise<ServerRestartReport> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  assertNotMigrationSource(server);

  const db = getDb();
  const [appRows, dbRows] = await Promise.all([
    db
      .select({
        slug: appsTable.slug,
        name: appsTable.name,
        status: appsTable.status,
      })
      .from(appsTable)
      .where(eq(appsTable.serverId, id)),
    db
      .select({
        host: databasesTable.host,
        name: databasesTable.name,
        status: databasesTable.status,
      })
      .from(databasesTable)
      .where(eq(databasesTable.serverId, id)),
  ]);

  const targets: Array<{
    kind: "app" | "database";
    slug: string;
    name: string;
    restart: boolean;
  }> = [
    ...appRows.map((a) => ({
      kind: "app" as const,
      slug: a.slug,
      name: a.name,
      restart: !LEAVE_ALONE_APP_STATUSES.has(a.status),
    })),
    ...dbRows.map((d) => ({
      kind: "database" as const,
      slug: d.host,
      name: d.name,
      restart: !LEAVE_ALONE_DB_STATUSES.has(d.status),
    })),
  ];

  const { AgentUnreachableError } =
    await import("../infra/agent-client/errors");
  const failures: RestartedWorkload[] = [];
  let restarted = 0;
  let skipped = 0;
  for (const target of targets) {
    if (!target.restart) {
      skipped++;
      continue;
    }
    try {
      await stopStackOn(id, target.slug);
    } catch (e) {
      if (e instanceof AgentUnreachableError && typeof e.code === "number")
        throw e;
      failures.push({ kind: target.kind, name: target.name, error: reason(e) });
      continue;
    }
    try {
      await startStackOn(id, target.slug);
      restarted++;
    } catch (e) {
      failures.push({
        kind: target.kind,
        name: target.name,
        error: `stopped, but did not start again: ${reason(e)}`,
      });
    }
  }

  await recordActivity(
    "server",
    `Restarted ${restarted} workload${restarted === 1 ? "" : "s"} on ${server.name}`,
    user.name,
    null,
    teamId,
  );
  return { restarted, skipped, failures };
}

const LEAVE_ALONE_APP_STATUSES: ReadonlySet<string> = new Set<AppStatus>([
  "idle",
  "stopping",
  "building",
  "queued",
]);

const LEAVE_ALONE_DB_STATUSES: ReadonlySet<string> = new Set([
  "stopped",
  "provisioning",
]);

const reason = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export async function restartServerTraefik(id: string): Promise<void> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  assertNotMigrationSource(server);

  const { applyTraefikConfig } = await import("../infra/agent-client/host-ops");
  const res = await applyTraefikConfig(id, { restartOnly: true });
  if (!res.ok)
    throw new Error(res.error || `Could not restart Traefik on ${server.name}`);
  await recordActivity(
    "server",
    `Restarted Traefik on ${server.name}`,
    user.name,
    null,
    teamId,
  );
}

export async function restartDeploPanel(id: string): Promise<void> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");
  if (!isDeploHostServer(server))
    throw new Error(
      `${server.name} does not run the Deplo panel - only the host running Deplo can restart it.`,
    );

  const { restartControlPlaneOn } =
    await import("../infra/agent-client/host-ops");
  const res = await restartControlPlaneOn(id, controlPlaneHint());
  if (!res.ok)
    throw new Error(res.error || "Deplo could not be restarted on this host");
  await recordActivity(
    "server",
    `Restarted the Deplo panel`,
    user.name,
    null,
    teamId,
  );
}

function controlPlaneHint(): string {
  return hostname();
}

function toHostInfo(info: {
  cpuModel: string;
  cpuCores: number;
  cpuThreads: number;
  memTotalBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  osPretty: string;
  kernel: string;
  arch: string;
  dockerVersion: string;
  dockerRootDir: string;
  uptimeSec: number;
  timezone: string;
  timeUnixMs: number;
  utcOffsetMinutes: number;
  controlPlaneContainer: string;
}): ServerHostInfo {
  return {
    cpuModel: info.cpuModel,
    cpuCores: info.cpuCores,
    cpuThreads: info.cpuThreads,
    memTotalBytes: Number(info.memTotalBytes),
    diskTotalBytes: Number(info.diskTotalBytes),
    diskUsedBytes: Number(info.diskUsedBytes),
    osPretty: info.osPretty,
    kernel: info.kernel,
    arch: info.arch,
    dockerVersion: info.dockerVersion,
    dockerRootDir: info.dockerRootDir,
    uptimeSec: Number(info.uptimeSec),
    timezone: info.timezone,
    timeUnixMs: Number(info.timeUnixMs),
    controlPlaneTimeUnixMs: Date.now(),
    utcOffsetMinutes: info.utcOffsetMinutes,
    canRestartControlPlane: Boolean(info.controlPlaneContainer),
  };
}
