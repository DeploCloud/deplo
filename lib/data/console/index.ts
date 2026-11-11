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
import { listAppLogMembers, listAppMembers } from "../clusters/placement";
import {
  replicaIndexOf,
  replicaLabels,
  replicaTag,
} from "../../deploy/replica-names";
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
  ALL_REPLICAS_PREFIX,
  replicaGroupOf,
  withReplicaGroups,
} from "./replicas";
import {
  containerName,
  listInstances,
  ON_SERVER,
  type ConsoleInstance,
} from "./instances";

export type { OverviewAppState, OverviewRuntime } from "./overview-app-states";
export {
  containerName,
  listInstances,
  type ConsoleInstance,
} from "./instances";
export {
  getAppRuntime,
  getOverviewAppStates,
  type AppRuntime,
  type RuntimeContainer,
} from "./runtime";

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

// A copy the console can open: its own container name, the server it is on, and how the picker names it.
interface Copy {
  instance: ConsoleInstance;
  target: string;
  serverId: string;
}

// An App's copies wherever they run: one server's as before, every server's when its replicas are spread.
// `down` names the servers that could not be asked; with none answering it throws as one server does.
async function listCopies(p: App): Promise<{ copies: Copy[]; down: string[] }> {
  const memberIds = await listAppMembers(p);
  if (memberIds.length < 2)
    return {
      copies: (await listInstances(p)).map((instance) => ({
        instance,
        target: instance.name,
        serverId: p.serverId,
      })),
      down: [],
    };
  const { up, down, error } = await listMemberCopies(p, memberIds);
  if (up.length === 0)
    throw error ?? new AgentUnreachableError("No server of this App answered");
  return {
    copies: up.flatMap((m) =>
      m.instances.map((i) => ({
        instance: onServer(i, m.server),
        target: `${i.name}${ON_SERVER}${m.server.id}`,
        serverId: m.server.id,
      })),
    ),
    down,
  };
}

// `web-1 · server-b`: how a picker names one server's copy.
const onServer = (i: ConsoleInstance, server: Server): ConsoleInstance => ({
  ...i,
  replica: `${i.replica ?? i.name} · ${server.name}`,
});

function pickCopy(
  copies: Copy[],
  target: string | undefined,
  fallback: "running" | "first",
): Copy | undefined {
  if (target) return copies.find((c) => c.target === target);
  return (
    (fallback === "running" && copies.find((c) => c.instance.running)) ||
    copies[0]
  );
}

async function consoleInstancesForDisplay(p: App): Promise<{
  instances: ConsoleInstance[];
  unavailable: string[];
}> {
  try {
    const { copies, down } = await listCopies(p);
    return {
      instances: copies.length
        ? copies.map((c) => ({ ...c.instance, name: c.target }))
        : [displayFallback(p)],
      unavailable: down,
    };
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      return { instances: [displayFallback(p)], unavailable: [] };
    throw e;
  }
}

// On several members of a cluster the picker lists every server's copies, each named with its server.
export async function getLogsInfo(appId: string): Promise<LogsInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return null;
  if (!(await hasAppCapability(appId, "view_logs"))) return null;
  const memberIds = await listAppLogMembers(p);
  const [found, supportsTimeline, maxDays] = await Promise.all([
    memberIds.length > 1
      ? memberCopiesForDisplay(p, memberIds)
      : listInstancesForDisplay(p).then((f) => ({
          ...f,
          instances: withReplicaGroups(f.instances, p.slug),
        })),
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

export interface ConsoleInfo {
  containerName: string;
  image: string;
  running: boolean;
  instances: ConsoleInstance[];
  // The servers running this App that could not be asked for their copies, by name.
  unavailable?: string[];
}

export async function getConsoleInfo(
  appId: string,
): Promise<ConsoleInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return null;
  await requireAppCapability(appId, "view");
  const { instances, unavailable } = await consoleInstancesForDisplay(p);
  const def = instances[0];
  return {
    containerName: def.name,
    image: def.image,
    running: instances.some((i) => i.running),
    instances,
    unavailable,
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
  let pick: Copy | undefined;
  try {
    pick = pickCopy((await listCopies(p)).copies, target, "running");
  } catch (e) {
    if (!(e instanceof AgentUnreachableError)) throw e;
  }
  if (!pick || !pick.instance.running) return "raw exec (no shell)";
  return probeShellLabel(p, pick);
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
    shell = await probeShellLabel(p, {
      instance: def,
      serverId: p.serverId,
    });
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
  copy: Pick<Copy, "instance" | "serverId">,
): Promise<string> {
  const conn = await connectAgent(copy.serverId);
  try {
    return await conn.shellLabel(p.id, copy.instance.name, copy.instance.image);
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
      reason:
        "not-found" | "no-instance" | "stopped" | "unreachable" | "forbidden";
    }
> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return { ok: false, reason: "not-found" };
  if (!(await hasAppCapability(appId, "open_app_console")))
    return { ok: false, reason: "forbidden" };
  await requireAppCapability(appId, "open_app_console");
  if (!p.consoleEnabled) return { ok: false, reason: "not-found" };

  let copies: Copy[];
  try {
    ({ copies } = await listCopies(p));
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      return { ok: false, reason: "unreachable" };
    throw e;
  }
  const pick = pickCopy(copies, target, "running");
  if (!pick) return { ok: false, reason: "no-instance" };
  if (!pick.instance.running) return { ok: false, reason: "stopped" };
  return {
    ok: true,
    instance: pick.instance,
    server: (await getServerById(pick.serverId)) ?? undefined,
  };
}

export interface LogsMember {
  server: Server;
  group: ConsoleInstance[];
}

type LogsTarget =
  | {
      ok: true;
      instance: ConsoleInstance;
      // Every copy to read when the target is a service with replicas; one entry otherwise.
      group: ConsoleInstance[];
      server: Server | undefined;
      // Only for an App read on several servers of its cluster: each one's copies, and the servers that cannot be read.
      members?: LogsMember[];
      unavailable?: string[];
    }
  | {
      ok: false;
      reason: "not-found" | "no-instance" | "unreachable" | "forbidden";
    };

function logsGroup(
  instances: ConsoleInstance[],
  target?: string,
): ConsoleInstance[] | null {
  const all = target?.startsWith(ALL_REPLICAS_PREFIX)
    ? target.slice(ALL_REPLICAS_PREFIX.length)
    : null;
  const pick =
    all !== null
      ? instances.find((i) => i.service === all)
      : target
        ? (instances.find((i) => i.name === target) ??
          instances.find((i) => i.service === target))
        : instances[0];
  if (!pick) return null;
  // A named copy reads alone; the service, or the default, reads every copy.
  const exact = all === null && !!target && pick.name === target;
  return exact ? [pick] : replicaGroupOf(instances, pick);
}

export async function resolveLogsTarget(
  appId: string,
  target?: string,
): Promise<LogsTarget> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return { ok: false, reason: "not-found" };
  if (!(await hasAppCapability(appId, "view_logs")))
    return { ok: false, reason: "forbidden" };

  const memberIds = await listAppLogMembers(p);
  if (memberIds.length > 1) return logsAcrossMembers(p, memberIds, target);

  let instances: ConsoleInstance[];
  try {
    instances = await listInstances(p);
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      return { ok: false, reason: "unreachable" };
    throw e;
  }
  const group = logsGroup(instances, target);
  if (!group) return { ok: false, reason: "no-instance" };
  return { ok: true, instance: group[0]!, group, server: await serverOf(p) };
}

type MemberCopies = { server: Server; instances: ConsoleInstance[] };

// A cluster App's copies on every server that holds some, each tagged as the replica it is; `down` are the servers
// that could not be read. With none readable, `error` is why the server it runs on now was not.
async function listMemberCopies(
  p: App,
  memberIds: string[],
): Promise<{ up: MemberCopies[]; down: string[]; error?: unknown }> {
  const listed = await Promise.all(
    memberIds.map(async (id) => {
      const server = await getServerById(id);
      if (!server) return null;
      try {
        const instances = await listInstances({ ...p, serverId: id });
        return { server, instances, error: null };
      } catch (error) {
        return { server, instances: null, error };
      }
    }),
  );
  const known = listed.filter((m) => m !== null);
  const up = known.filter((m) => m.instances !== null);
  // A replica is one of the App's copies wherever it runs: one on each of two servers is still two.
  const labels = replicaLabels(
    [...new Set(up.flatMap((m) => m.instances!.map((i) => i.name)))],
    p.slug,
  );
  // With a server out of reach, or each server numbering its own, a copy can look alone; an App set to several replicas still names it.
  const lone = (name: string) =>
    p.replicas > 1 && replicaIndexOf(name) !== null
      ? replicaTag(name, p.slug)
      : null;
  return {
    up: up.map((m) => ({
      server: m.server,
      instances: m.instances!.map((i) => ({
        ...i,
        replica: labels.get(i.name)?.label ?? lone(i.name),
      })),
    })),
    down: known.filter((m) => m.instances === null).map((m) => m.server.name),
    error: known.find((m) => m.server.id === p.serverId)?.error,
  };
}

// What the logs picker lists for an App on several servers: "all replicas" first, then each copy as `web-1 · server-b`.
async function memberCopiesForDisplay(
  p: App,
  memberIds: string[],
): Promise<{
  instances: ConsoleInstance[];
  real: boolean;
  unreachable: boolean;
}> {
  const { up } = await listMemberCopies(p, memberIds);
  const all = up.flatMap((m) => m.instances);
  if (all.length === 0)
    return {
      instances: [displayFallback(p)],
      real: false,
      unreachable: up.length === 0,
    };
  const out: ConsoleInstance[] = [];
  const grouped = new Set<string>();
  for (const m of up)
    for (const i of m.instances) {
      const copies = all.filter((c) => c.service === i.service);
      if (i.replica && copies.length > 1 && !grouped.has(i.service)) {
        grouped.add(i.service);
        const running = copies.some((c) => c.running);
        out.push({
          ...i,
          name: `${ALL_REPLICAS_PREFIX}${i.service}`,
          replica: `${i.replica.replace(/-\d+$/, "")} · all replicas`,
          running,
          state: running ? "running" : i.state,
        });
      }
      out.push({
        ...onServer(i, m.server),
        name: `${i.name}${ON_SERVER}${m.server.id}`,
      });
    }
  return { instances: out, real: true, unreachable: false };
}

async function logsAcrossMembers(
  p: App,
  memberIds: string[],
  target?: string,
): Promise<LogsTarget> {
  const { up, down, error } = await listMemberCopies(p, memberIds);
  if (up.length === 0) {
    if (!error || error instanceof AgentUnreachableError)
      return { ok: false, reason: "unreachable" };
    throw error;
  }
  const at = target?.lastIndexOf(ON_SERVER) ?? -1;
  const only =
    at > 0 && memberIds.includes(target!.slice(at + 1))
      ? target!.slice(at + 1)
      : null;
  const wanted = only ? target!.slice(0, at) : target;
  const members: LogsMember[] = [];
  for (const m of up) {
    if (only && m.server.id !== only) continue;
    const group = logsGroup(m.instances, wanted);
    if (group) members.push({ server: m.server, group });
  }
  const first = members[0];
  if (!first) return { ok: false, reason: "no-instance" };
  return {
    ok: true,
    instance: first.group[0]!,
    group: first.group,
    server: first.server,
    // A copy picked on one server is read there alone, whatever the other servers are doing.
    ...(!only && (members.length > 1 || down.length > 0)
      ? { members, unavailable: down }
      : {}),
  };
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
    const pick = pickCopy((await listCopies(p)).copies, target, "first");
    if (!pick) return { output: `! no such instance: ${target}` };

    const res = await execOnAgent(p, pick, command);

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
  copy: Copy,
  command: string,
): Promise<{ stdout: string; stderr: string; code: number; rawMode: boolean }> {
  const conn: AgentConnection = await connectAgent(copy.serverId);
  try {
    return await conn.exec(
      p.id,
      copy.instance.name,
      command,
      copy.instance.image,
    );
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
