import "server-only";

// https://deplo.build/docs/guides/observability/console

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
  // Probed label of the DEFAULT instance: "/bin/sh" | "/bin/bash" | "raw exec (no shell)".
  shell: string;
  // Every container in the stack; the first entry is the default target.
  instances: ConsoleInstance[];
}

export interface ConsoleInstance {
  // The real container name to `docker exec` into.
  name: string;
  // Compose service name (…-<service>-N), or the slug for single-image.
  service: string;
  image: string;
  running: boolean;
  // The Traefik-exposed service that actually serves the app.
  exposed: boolean;
  // Effective user from container config ("root" when unset).
  user: string;
  // Effective working dir from container config ("/" when unset).
  workdir: string;
  // stdin open: when false, attach is output-only (the app never reads input).
  openStdin: boolean;
  // TTY allocated: control chars (Ctrl-C) reach the app as signals.
  tty: boolean;
  // Raw docker state; EMPTY when the owning agent predates the field, and "" is unknown, not stopped.
  state: string;
  // "healthy" | "unhealthy" | "starting", or "" for no healthcheck - NOT a synonym for healthy.
  health: string;
  restartCount: number;
  // Epoch seconds; 0 = never started, or an agent older than the field - no uptime to show.
  startedAtUnix: number;
}

// containerName: a preview passes its own deploy key (`<slug>__pr-<n>`) to reach its own container.
export function containerName(p: App, deployKey: string = p.slug): string {
  return `deplo-${deployKey}`;
}

// listInstances: every attachable container for an app, default target first.
export async function listInstances(p: App): Promise<ConsoleInstance[]> {
  // The exposed service comes from the primary domain - the `domains` table is the routing source.
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

// Own service, then exposed, then running: running is deliberately the LAST tiebreak.
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

// LogsInfo: container discovery without the shell probe.
export interface LogsInfo {
  // At least one container of the app is in docker state "running".
  running: boolean;
  // A real container exists, so `docker logs` has output - running, restarting or long dead.
  streamable: boolean;
  // The agent could not be reached: the list below is a placeholder, not truth.
  unreachable: boolean;
  instances: ConsoleInstance[];
  // Agent `logs.timerange`. A SOFT gate: never a reason to withhold the logs themselves.
  supportsTimeline: boolean;
  // Ceiling on that range, in days - read here so the logs page needs one round trip, not two.
  logMaxDays: number;
}

// Placeholder so a page still renders when the agent is unreachable or the list comes back empty.
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
    // Unknown, not "stopped": this entry exists because we could not ask.
    state: "",
    health: "",
    restartCount: 0,
    startedAtUnix: 0,
  };
}

// Never throws, never empty: degrades to a not-running placeholder so the page always loads.
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
  // Without `view_logs` there is nothing to point a stream at; soft (null) because it feeds a page.
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

// RuntimeContainer: one container of an app, as the host actually has it right now.
export interface RuntimeContainer {
  name: string;
  service: string;
  // Raw docker state, or "" when the owning agent is too old to report it (bool only).
  state: string;
  // "healthy" | "unhealthy" | "starting", or "" for an image with no healthcheck.
  health: string;
  restartCount: number;
  // Epoch seconds; 0 = never started, or an agent older than the field - no uptime to show.
  startedAtUnix: number;
  running: boolean;
  exposed: boolean;
}

// AppRuntime is read live from the agent; `apps.status` only records the last action asked for.
export interface AppRuntime {
  // Containers that exist for this app, in any state. 0 = the stack is gone.
  total: number;
  running: number;
  // How many docker is restarting right now - i.e. a crash loop.
  restarting: number;
  // Running but FAILING their own healthcheck: up, listening and broken.
  unhealthy: number;
  // Services the app declares that have NO container on the host at all.
  missing: string[];
  containers: RuntimeContainer[];
  // The agent could not be reached: the counts are UNKNOWN, not zero.
  unreachable: boolean;
}

// Several clients poll the same app at once: hold each answer briefly to keep a burst to one round trip.
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

    // An agent older than the state field sends "", and a bool cannot separate restarting from dead.
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
      } catch {
        // best-effort: an Inspect failure just leaves the state unknown
      }
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

// Deplo runs the http check itself; the verdict lands on the routed container (lib/apps/http-health.ts).
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
  // Asked at most once per `Interval`, however many pages are watching.
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
    // Unreachable, refused or timed out is a FAILED check: the container was up and did not answer.
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

// ConsoleInfo carries no shell probe: the client fetches the label after mount via `shellLabelAction`.
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

// getShellLabel shares the 5-minute per-container probe cache with `getAttachInfo`.
export async function getShellLabel(
  appId: string,
  target?: string,
): Promise<string> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return "raw exec (no shell)";
  await requireAppCapability(appId, "view");
  // Display-grade: an unreachable remote degrades to a placeholder, so this answers raw, never throws.
  const { instances } = await listInstancesForDisplay(p);
  // A shell can only be probed in a RUNNING container, so this prefers running over the app's own.
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
  // orderInstances puts the app's OWN container first, so instances[0] is the default target.
  const def = instances[0];
  const running = instances.some((i) => i.running);
  // A stopped or unreachable container cannot be probed, so it reports raw.
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

// resolveAttachTarget never trusts a raw container name: the target must belong to this app
// (same guard as execInContainer).
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
  // Attach is stdin to PID 1 of the live container: console capability, never bare membership.
  const { teamId } = await requireAppCapability(appId, "open_app_console");
  const p = await loadTeamApp(appId, teamId);
  // A console that is off answers "not-found": the switch is existence, not a permission to explain.
  if (!p || !p.consoleEnabled) return { ok: false, reason: "not-found" };

  let instances: ConsoleInstance[];
  try {
    instances = await listInstances(p);
  } catch (e) {
    // Fail clearly, never fall back to the local socket: that attaches a foreign/empty container.
    if (e instanceof AgentUnreachableError)
      return { ok: false, reason: "unreachable" };
    throw e;
  }
  const pick = target
    ? instances.find((i) => i.name === target)
    : (instances.find((i) => i.running) ?? instances[0]);
  if (!pick) return { ok: false, reason: "no-instance" };
  // Attaching to a stopped container's PID 1 would just hang - refuse early.
  if (!pick.running) return { ok: false, reason: "stopped" };
  return { ok: true, instance: pick, server: await serverOf(p) };
}

// resolveLogsTarget rejects an unknown raw name: the target must belong to this app.
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
  // Logs print whatever the app prints, secrets included: `view_logs`. A reason, not a throw,
  // because the caller is an SSE route that turns this into a 403 instead of a 500.
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
  // Default to the app's own container, not the first running one: in a crash loop that is a sidecar.
  // A target is a CONTAINER name (what the picker sends) or a compose SERVICE name.
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
  // Arbitrary commands in the live container are RCE: console capability, never bare membership.
  const { teamId } = await requireAppCapability(appId, "open_app_console");
  const p = await loadTeamApp(appId, teamId);
  if (!p) return { output: "Error: project not found" };
  // Read per command, so turning the switch off ends the session in flight.
  if (!p.consoleEnabled) return { output: CONSOLE_OFF_MESSAGE, detach: true };

  const command = rawCommand.trim();
  if (!command) return { output: "" };
  if (command === "exit" || command === "logout")
    return { output: "session closed", detach: true };
  if (command === "clear") return { output: "\f" };

  try {
    const instances = await listInstances(p);
    // Only exec into a container of this app: never trust a raw name from the client.
    const pick = target
      ? instances.find((i) => i.name === target)
      : instances[0];
    if (!pick) return { output: `! no such instance: ${target}` };

    // The agent does the shell/raw dispatch and returns the guest exit code; a docker-level
    // failure arrives as a thrown gRPC error instead (caught below).
    const res = await execOnAgent(p, pick.name, command, pick.image);

    // Docker could not run the command at all: container gone, daemon error, or no shell (distroless).
    if (isDockerLevelStderr(res.stderr)) {
      const reason =
        res.stderr.trim() || `docker exec failed (exit ${res.code})`;
      return { output: `! ${reason}` };
    }

    // stderr here is the command's OWN output, not a failure - docker-level stderr was handled above.
    // The exit-code hint goes out only when a non-zero command printed nothing, so failure is not silent.
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
    // Reject path: docker never produced an exit status, so this is infrastructure, not guest output.
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

// setConsoleEnabled OFF kills the open attach sessions, so revocation is immediate.
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
