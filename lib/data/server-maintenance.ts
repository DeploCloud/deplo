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

/** What a host reports about itself, plus what the control plane knows about it. */
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
  /** Deplo's own clock when this reading landed, so drift excludes the viewer's machine. */
  controlPlaneTimeUnixMs: number;
  utcOffsetMinutes: number;
  /** Whether the panel runs in a container the agent could restart. */
  canRestartControlPlane: boolean;
};

/** Per-workload outcome of a whole-server restart. */
export type RestartedWorkload = {
  kind: "app" | "database";
  name: string;
  /** Why it did not come back, verbatim for the operator. */
  error: string | null;
};

export type ServerRestartReport = {
  restarted: number;
  /** Workloads left alone: already stopped, or with a deploy in flight. */
  skipped: number;
  failures: RestartedWorkload[];
};

// Read what this host IS. Deliberately not cached - a stored answer goes stale.
export async function serverHostInfo(id: string): Promise<ServerHostInfo> {
  await requireInstanceAdmin();
  // Not redundant with the gate above: the 2FA POLICY lives in requireActiveTeamId.
  await requireActiveTeamId();
  const server = await getServerById(id);
  if (!server) throw new Error("Server not found");

  const { fetchHostInfo } = await import("../infra/agent-client/host-ops");
  const info = await fetchHostInfo(id, {
    controlPlaneHint: controlPlaneHint(),
  });
  return toHostInfo(info);
}

// Move a host's clock to an IANA timezone. The agent re-validates the zone itself.
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

// The CANONICAL IANA name for what the caller sent, or null if it is not a zone.
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

// Restart every App and database Deplo runs on this server.
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
    // status is the App's own INTENT: the last thing the control plane was asked to do,
    // not what the host has (lib/apps/display-status.ts).
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
      // `host` IS the stack slug (`db-<name>`), not the connection string's host.
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
  // Sequential on purpose: concurrent compose invocations on one host make an outage.
  for (const target of targets) {
    if (!target.restart) {
      skipped++;
      continue;
    }
    try {
      await stopStackOn(id, target.slug);
    } catch (e) {
      // A host that did not ANSWER (a gRPC code = the dial failed) fails all the rest.
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

// App statuses a restart passes over: down already, or with a deploy in flight.
const LEAVE_ALONE_APP_STATUSES: ReadonlySet<string> = new Set<AppStatus>([
  "idle",
  "stopping",
  "building",
  "queued",
]);

// The same call for databases: `stopped` is down, `provisioning` has no stack yet.
const LEAVE_ALONE_DB_STATUSES: ReadonlySet<string> = new Set([
  "stopped",
  "provisioning",
]);

const reason = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

// Restart the host's Traefik. Not a config change: the stack file is untouched.
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

// Restart the Deplo panel - only ever on the host that runs it.
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
  // Recorded BEFORE the restart lands (it is scheduled a moment out), so the trail
  // survives the process going away mid-request.
  await recordActivity(
    "server",
    `Restarted the Deplo panel`,
    user.name,
    null,
    teamId,
  );
}

// How the control plane names itself to the agent: its hostname IS the container id.
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
