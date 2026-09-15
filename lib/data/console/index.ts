import "server-only";

import { and, eq } from "drizzle-orm";

import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { nowIso } from "../../ids";
import { recordActivity } from "../activity";
import { destroyForApp } from "../../attach/session";
import { getServerById } from "../servers/roster";
import { requireActiveTeamId } from "../../membership";
import { hasAppCapability, requireAppCapability } from "../node-access";
import { loadTeamApp } from "../app-graph-load";
import { primaryDomainApp } from "../domains/primary-domain";
import { composeServiceNames } from "../../deploy/compose-stack/compose-read";
import { portFor } from "../../deploy/ports";
import {
  httpHealthVerdict,
  recentHttpHealth,
  withinStartPeriod,
} from "../../apps/http-health";
import { isDockerLevelStderr } from "../../infra/docker";
import { connectAgent } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { AgentUnreachableError } from "../../infra/agent-client/errors";
import { LOGS_TIMERANGE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { serverSupports } from "../../infra/agent-client/preflight";
import { logMaxDays } from "../instance-settings/settings-store";
import type { App } from "../../types/app";
import type { Server } from "../../types/server";
import {
  loadOverviewAppStates,
  type OverviewAppState,
} from "./overview-app-states";

export type { OverviewAppState, OverviewRuntime } from "./overview-app-states";

const CONSOLE_OFF_MESSAGE = "! the console is turned off for this app";

async function serverOf(p: App): Promise<Server | undefined> {
  return (await getServerById(p.serverId)) ?? undefined;
}

export interface AttachInfo {
  containerName: string;
  image: string;
  running: boolean;
  shell: string;
  instances: ConsoleInstance[];
}

export interface ConsoleInstance {
  name: string;
  service: string;
  image: string;
  running: boolean;
  exposed: boolean;
  user: string;
  workdir: string;
  openStdin: boolean;
  tty: boolean;
  state: string;
  health: string;
  restartCount: number;
  startedAtUnix: number;
}

export function containerName(p: App, deployKey: string = p.slug): string {
  return `deplo-${deployKey}`;
}

export async function listInstances(p: App): Promise<ConsoleInstance[]> {
  const exposeService = await primaryDomainApp(p.id);
  const conn = await connectAgent(p.serverId);
  try {
    return orderInstances(
      p,
      await conn.listInstances(p.id, p.slug, exposeService),
    );
  } finally {
    conn.close();
  }
}

function orderInstances(
  p: App,
  instances: ConsoleInstance[],
): ConsoleInstance[] {
  const own = (i: ConsoleInstance) => i.service === p.slug;
  return [...instances].sort((a, b) => {
    if (own(a) !== own(b)) return own(a) ? -1 : 1;
    if (a.exposed !== b.exposed) return a.exposed ? -1 : 1;
    if (a.running !== b.running) return a.running ? -1 : 1;
    return a.service.localeCompare(b.service);
  });
}

export interface LogsInfo {
  running: boolean;
  streamable: boolean;
  unreachable: boolean;
  instances: ConsoleInstance[];
  supportsTimeline: boolean;
  logMaxDays: number;
}

function displayFallback(p: App): ConsoleInstance {
  return {
    name: containerName(p),
    service: p.slug,
    image: p.dockerImage ?? `deplo/${p.slug}:latest`,
    running: false,
    exposed: true,
    user: "root",
    workdir: "/",
    openStdin: false,
    tty: false,
    state: "",
    health: "",
    restartCount: 0,
    startedAtUnix: 0,
  };
}

async function listInstancesForDisplay(p: App): Promise<{
  instances: ConsoleInstance[];
  real: boolean;
  unreachable: boolean;
}> {
  try {
    const instances = await listInstances(p);
    return instances.length
      ? { instances, real: true, unreachable: false }
      : { instances: [displayFallback(p)], real: false, unreachable: false };
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      return {
        instances: [displayFallback(p)],
        real: false,
        unreachable: true,
      };
    throw e;
  }
}

export async function getLogsInfo(appId: string): Promise<LogsInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return null;
  if (!(await hasAppCapability(appId, "view_logs"))) return null;
  const [found, supportsTimeline, maxDays] = await Promise.all([
    listInstancesForDisplay(p),
    serverSupports(p.serverId, LOGS_TIMERANGE_CAPABILITY),
    logMaxDays(),
  ]);
  return {
    running: found.instances.some((i) => i.running),
    streamable: found.real,
    unreachable: found.unreachable,
    instances: found.instances,
    supportsTimeline,
    logMaxDays: maxDays,
  };
}

export interface RuntimeContainer {
  name: string;
  service: string;
  state: string;
  health: string;
  restartCount: number;
  startedAtUnix: number;
  running: boolean;
  exposed: boolean;
}

export interface AppRuntime {
  total: number;
  running: number;
  restarting: number;
  unhealthy: number;
  missing: string[];
  containers: RuntimeContainer[];
  unreachable: boolean;
}

const RUNTIME_TTL_MS = 3_000;
const runtimeCache = new Map<string, { at: number; value: AppRuntime }>();

export async function getAppRuntime(appId: string): Promise<AppRuntime | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return null;
  await requireAppCapability(appId, "view");

  const hit = runtimeCache.get(p.id);
  if (hit && Date.now() - hit.at < RUNTIME_TTL_MS) return hit.value;

  const value = await probeRuntime(p);
  runtimeCache.set(p.id, { at: Date.now(), value });
  return value;
}

async function probeRuntime(p: App): Promise<AppRuntime> {
  const exposeService = await primaryDomainApp(p.id);
  let conn: AgentConnection;
  try {
    conn = await connectAgent(p.serverId);
  } catch {
    return unknownRuntime();
  }
  try {
    const instances = orderInstances(
      p,
      await conn.listInstances(p.id, p.slug, exposeService),
    );

    let legacySoloState = "";
    const agentReportsState = instances.some((i) => i.state !== "");
    if (
      !agentReportsState &&
      instances.length === 1 &&
      instances[0].name === containerName(p)
    ) {
      try {
        const seen = await conn.inspect(p.slug);
        if (seen.exists) legacySoloState = seen.state;
      } catch {}
    }

    const containers: RuntimeContainer[] = instances.map((i, idx) => ({
      name: i.name,
      service: i.service,
      state: i.state || (idx === 0 ? legacySoloState : ""),
      health: i.health,
      restartCount: i.restartCount,
      startedAtUnix: i.startedAtUnix,
      running: i.running,
      exposed: i.exposed,
    }));

    const declared = p.compose ? composeServiceNames(p.compose) : [p.slug];
    const present = new Set(containers.map((c) => c.service));
    const missing = declared.filter((s) => !present.has(s));

    await applyHttpHealth(p, conn, containers, exposeService);

    return {
      total: containers.length,
      running: containers.filter((c) => c.running).length,
      restarting: containers.filter((c) => c.state === "restarting").length,
      unhealthy: containers.filter((c) => c.running && c.health === "unhealthy")
        .length,
      missing,
      containers,
      unreachable: false,
    };
  } catch (e) {
    if (e instanceof AgentUnreachableError) return unknownRuntime();
    throw e;
  } finally {
    conn.close();
  }
}

async function applyHttpHealth(
  p: App,
  conn: AgentConnection,
  containers: RuntimeContainer[],
  exposeService: string,
): Promise<void> {
  const h = p.healthCheck;
  if (h?.type !== "http") return;
  const target =
    containers.find((c) => c.running && c.service === exposeService) ??
    containers.find((c) => c.running);
  if (!target) return;
  if (withinStartPeriod(target.startedAtUnix, h.startPeriodS)) {
    target.health = "starting";
    return;
  }
  const recent = recentHttpHealth(p.id, h.intervalS);
  if (recent) {
    target.health = recent;
    return;
  }
  let ok = false;
  try {
    const res = await conn.probeHttp({
      appId: p.id,
      slug: p.slug,
      service: target.service,
      port: h.port ?? portFor(p),
      path: h.path?.trim() || "/",
      host: "",
      maxBytes: 1,
    });
    ok = res.status > 0 && res.status < 400;
  } catch {
    ok = false;
  }
  target.health = httpHealthVerdict(p.id, ok, h.retries);
}

function unknownRuntime(): AppRuntime {
  return {
    total: 0,
    running: 0,
    restarting: 0,
    unhealthy: 0,
    missing: [],
    containers: [],
    unreachable: true,
  };
}

export async function getOverviewAppStates(
  requestedIds: string[],
): Promise<OverviewAppState[]> {
  return loadOverviewAppStates(requestedIds, async (appId) => {
    try {
      return (await getAppRuntime(appId)) ?? unknownRuntime();
    } catch {
      return unknownRuntime();
    }
  });
}

export interface ConsoleInfo {
  containerName: string;
  image: string;
  running: boolean;
  instances: ConsoleInstance[];
}

export async function getConsoleInfo(
  appId: string,
): Promise<ConsoleInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return null;
  await requireAppCapability(appId, "view");
  const { instances } = await listInstancesForDisplay(p);
  const def = instances[0];
  return {
    containerName: def.name,
    image: def.image,
    running: instances.some((i) => i.running),
    instances,
  };
}

export async function getShellLabel(
  appId: string,
  target?: string,
): Promise<string> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return "raw exec (no shell)";
  await requireAppCapability(appId, "view");
  const { instances } = await listInstancesForDisplay(p);
  const pick = target
    ? instances.find((i) => i.name === target)
    : (instances.find((i) => i.running) ?? instances[0]);
  if (!pick || !pick.running) return "raw exec (no shell)";
  return probeShellLabel(p, pick.name, pick.image);
}

export async function getAttachInfo(appId: string): Promise<AttachInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return null;
  await requireAppCapability(appId, "view");
  const { instances } = await listInstancesForDisplay(p);
  const def = instances[0];
  const running = instances.some((i) => i.running);
  let shell = "raw exec (no shell)";
  if (running) {
    shell = await probeShellLabel(p, def.name, def.image);
  }
  return {
    containerName: def.name,
    image: def.image,
    running,
    shell,
    instances,
  };
}

async function probeShellLabel(
  p: App,
  container: string,
  image: string,
): Promise<string> {
  const conn = await connectAgent(p.serverId);
  try {
    return await conn.shellLabel(p.id, container, image);
  } catch (e) {
    if (e instanceof AgentUnreachableError) return "raw exec (no shell)";
    throw e;
  } finally {
    conn.close();
  }
}

export async function resolveAttachTarget(
  appId: string,
  target?: string,
): Promise<
  | { ok: true; instance: ConsoleInstance; server: Server | undefined }
  | {
      ok: false;
      reason: "not-found" | "no-instance" | "stopped" | "unreachable";
    }
> {
  const { teamId } = await requireAppCapability(appId, "open_app_console");
  const p = await loadTeamApp(appId, teamId);
  if (!p || !p.consoleEnabled) return { ok: false, reason: "not-found" };

  let instances: ConsoleInstance[];
  try {
    instances = await listInstances(p);
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      return { ok: false, reason: "unreachable" };
    throw e;
  }
  const pick = target
    ? instances.find((i) => i.name === target)
    : (instances.find((i) => i.running) ?? instances[0]);
  if (!pick) return { ok: false, reason: "no-instance" };
  if (!pick.running) return { ok: false, reason: "stopped" };
  return { ok: true, instance: pick, server: await serverOf(p) };
}

export async function resolveLogsTarget(
  appId: string,
  target?: string,
): Promise<
  | { ok: true; instance: ConsoleInstance; server: Server | undefined }
  | {
      ok: false;
      reason: "not-found" | "no-instance" | "unreachable" | "forbidden";
    }
> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return { ok: false, reason: "not-found" };
  if (!(await hasAppCapability(appId, "view_logs")))
    return { ok: false, reason: "forbidden" };

  let instances: ConsoleInstance[];
  try {
    instances = await listInstances(p);
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      return { ok: false, reason: "unreachable" };
    throw e;
  }
  const pick = target
    ? (instances.find((i) => i.name === target) ??
      instances.find((i) => i.service === target))
    : instances[0];
  if (!pick) return { ok: false, reason: "no-instance" };
  return { ok: true, instance: pick, server: await serverOf(p) };
}

export async function execInContainer(
  appId: string,
  rawCommand: string,
  target?: string,
): Promise<{ output: string; detach?: boolean }> {
  const { teamId } = await requireAppCapability(appId, "open_app_console");
  const p = await loadTeamApp(appId, teamId);
  if (!p) return { output: "Error: project not found" };
  if (!p.consoleEnabled) return { output: CONSOLE_OFF_MESSAGE, detach: true };

  const command = rawCommand.trim();
  if (!command) return { output: "" };
  if (command === "exit" || command === "logout")
    return { output: "session closed", detach: true };
  if (command === "clear") return { output: "\f" };

  try {
    const instances = await listInstances(p);
    const pick = target
      ? instances.find((i) => i.name === target)
      : instances[0];
    if (!pick) return { output: `! no such instance: ${target}` };

    const res = await execOnAgent(p, pick.name, command, pick.image);

    if (isDockerLevelStderr(res.stderr)) {
      const reason =
        res.stderr.trim() || `docker exec failed (exit ${res.code})`;
      return { output: `! ${reason}` };
    }

    const body = [res.stdout, res.stderr]
      .filter(Boolean)
      .join("\n")
      .replace(/\n+$/, "");
    if (res.code !== 0) {
      const hint = `[exit ${res.code}]`;
      return { output: body ? `${body}\n${hint}` : hint };
    }
    return { output: body };
  } catch (e) {
    if (e instanceof AgentUnreachableError) {
      return { output: `! Server unreachable: ${e.message}` };
    }
    return {
      output: `! ${e instanceof Error ? e.message : "command failed"}`,
    };
  }
}

async function execOnAgent(
  p: App,
  container: string,
  command: string,
  image: string,
): Promise<{ stdout: string; stderr: string; code: number; rawMode: boolean }> {
  const conn: AgentConnection = await connectAgent(p.serverId);
  try {
    return await conn.exec(p.id, container, command, image);
  } finally {
    conn.close();
  }
}

export async function setConsoleEnabled(
  appId: string,
  enabled: boolean,
): Promise<void> {
  const { teamId } = await requireAppCapability(appId, "configure_apps");
  const rows = await getDb()
    .update(appsTable)
    .set({ consoleEnabled: enabled, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, appId), eq(appsTable.teamId, teamId)))
    .returning({ name: appsTable.name });
  if (rows.length === 0) throw new Error("App not found");
  if (!enabled) destroyForApp(appId);
  const user = await getCurrentUser();
  await recordActivity(
    "app",
    `${enabled ? "Enabled" : "Disabled"} the console for ${rows[0].name}`,
    user?.name ?? "Deplo",
    appId,
  );
}
