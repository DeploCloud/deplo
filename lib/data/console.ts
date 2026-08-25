import "server-only";

// https://deplo.build/docs/guides/observability/console-and-files

import { and, eq } from "drizzle-orm";

import { getCurrentUser } from "../auth";
import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane";
import { nowIso } from "../ids";
import { recordActivity } from "./activity";
import { destroyForApp } from "../attach/session";
import { getServerById } from "./servers";
import { requireActiveTeamId } from "../membership";
import { hasAppCapability, requireAppCapability } from "./node-access";
import { loadTeamApp } from "./app-graph-load";
import { primaryDomainApp } from "./domains";
import { composeServiceNames } from "../deploy/compose-stack";
import { isDockerLevelStderr } from "../infra/docker";
import {
  connectAgent,
  serverSupports,
  AgentUnreachableError,
  LOGS_TIMERANGE_CAPABILITY,
  type AgentConnection,
} from "../infra/agent-client";
import { logMaxDays } from "./instance-settings";
import type { App, Server } from "../types";

/**
 * Resolve a project's owning server.
 */
async function serverOf(p: App): Promise<Server | undefined> {
  return (await getServerById(p.serverId)) ?? undefined;
}

/**
 * Real container console. Commands are forwarded to the project's running
 * container via `docker exec` over the socket; output is the container's actual
 * stdout/stderr. No simulation.
 */

export interface AttachInfo {
  containerName: string;
  image: string;
  running: boolean;
  /**
   * Shell label of the default instance: "/bin/sh" | "/bin/bash" |
   * "raw exec (no shell)". Real (probed), not assumed — drives the no-shell
   * notice. Reflects the default instance only; switching is handled client-side.
   */
  shell: string;
  /**
   * Every container in the project's stack, so the console can offer an instance
   * picker. The first entry is the default target returned above. Single-image
   * deploys yield exactly one.
   */
  instances: ConsoleInstance[];
}

export interface ConsoleInstance {
  /** The real container name to `docker exec` into. */
  name: string;
  /** Compose service name (…-<service>-N), or the slug for single-image. */
  service: string;
  image: string;
  running: boolean;
  /** The Traefik-exposed service that actually serves the app. */
  exposed: boolean;
  /** Effective user from container config ("root" when unset). */
  user: string;
  /** Effective working dir from container config ("/" when unset). */
  workdir: string;
  /**
   * Container was started with stdin open — `docker attach` keystrokes reach
   * PID 1. When false, attach is output-only (the app never reads input).
   */
  openStdin: boolean;
  /**
   * Container has a TTY allocated — attach is a raw interactive terminal and
   * control chars (e.g. Ctrl-C → \x03) reach the app as signals.
   */
  tty: boolean;
  /**
   * Raw docker state ("running" | "restarting" | "exited" | …), straight from
   * the owning agent. EMPTY when that agent predates the field — `running`
   * alone cannot separate a crash loop from a clean stop, so "" means unknown.
   */
  state: string;
  /** "healthy" | "unhealthy" | "starting", or "" when the image declares no
   *  healthcheck — which is NOT a synonym for healthy. */
  health: string;
  /** Times docker has restarted this container: what turns "it is starting" into
   *  "it has been dying all afternoon". */
  restartCount: number;
}

/**
 * The container an App's console/logs attach to. `deployKey` defaults to the
 * app's own slug — a pull request preview passes its key
 * (`<slug>__pr-<n>`) to reach its own container instead.
 */
export function containerName(p: App, deployKey: string = p.slug): string {
  return `deplo-${deployKey}`;
}

/**
 * Every attachable container for a project, default (exposed/running) first — via
 * the owning agent's ListInstances (ordering applied agent-side).
 */
export async function listInstances(p: App): Promise<ConsoleInstance[]> {
  // The "exposed" service to flag for ordering now comes from the project's
  // primary domain (the `domains` table is the routing source), not a stored
  // `expose`. Empty for single-image apps / apps with no domain.
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

/**
 * Default-target order for a stack: the app's OWN service first, then the
 * Traefik-exposed one, then whatever is running, then alphabetically. Running is
 * deliberately the LAST tiebreak, not the first.
 */
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

/**
 * Container discovery without the shell probe.
 */
export interface LogsInfo {
  /** At least one container of the app is in docker state "running". */
  running: boolean;
  /**
   * A real container exists on the host, so `docker logs` has output to stream —
   * whether it is running, restarting or long dead.
   */
  streamable: boolean;
  /** The agent could not be reached: the list below is a placeholder, not truth. */
  unreachable: boolean;
  instances: ConsoleInstance[];
  /**
   * The owning host's agent can narrow a log stream by time (`logs.timerange`). A
   * SOFT gate: never a reason to withhold the logs themselves.
   */
  supportsTimeline: boolean;
  /** The instance's ceiling on that time range, in days. Read here so the logs
   *  page needs one round trip, not two. */
  logMaxDays: number;
}

/**
 * A single honest placeholder instance for the console/logs PAGE render when the
 * real list can't be obtained: a remote whose agent is unreachable, or a reachable
 * remote with zero containers (which returns []).
 */
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
  };
}

/**
 * listInstances for a page render: never throws, never empty — degrades to a
 * single honest, not-running placeholder so the console/logs page always loads.
 */
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
  // The viewer's own gate: without `view_logs` there is nothing to point a log
  // stream at, so the picker resolves nothing rather than listing containers a
  // caller may not read. Soft (null) because it feeds a page, not an action.
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

/* ------------------------------------------------------------------ */
/* Runtime truth                                                       */
/* ------------------------------------------------------------------ */

/** One container of an app, as the host actually has it right now. */
export interface RuntimeContainer {
  name: string;
  service: string;
  /**
   * The raw docker state — "running" | "restarting" | "exited" | "created" |
   * "paused" | "dead", or "" when the owning agent is too old to report it (it
   * only answers a running/not-running boolean).
   */
  state: string;
  /** "healthy" | "unhealthy" | "starting", or "" for an image with no healthcheck. */
  health: string;
  /** Times docker has restarted it — the difference between "booting" and "dying". */
  restartCount: number;
  running: boolean;
  exposed: boolean;
}

/**
 * What an app's containers are ACTUALLY doing on the host, read live from the
 * owning agent — as opposed to `apps.status`, which only records the last thing
 * the control plane asked for (deploy / start / stop) and therefore keeps
 */
export interface AppRuntime {
  /** Containers that exist for this app, in any state. 0 = the stack is gone. */
  total: number;
  /** How many are in docker state "running". */
  running: number;
  /** How many docker is restarting right now — i.e. a crash loop. */
  restarting: number;
  /**
   * How many are running but FAILING their own healthcheck. Up, listening, and
   * broken — the state a running/not-running boolean can never express.
   */
  unhealthy: number;
  /**
   * Services the app declares that have NO container on the host at all.
   */
  missing: string[];
  containers: RuntimeContainer[];
  /** The agent could not be reached: the counts are UNKNOWN, not zero. */
  unreachable: boolean;
}

/**
 * The live runtime probe is polled (the app header, the logs page) and several
 * clients can watch the same app at once, so hold each answer briefly to keep a
 * burst of pollers down to one round trip per app.
 */
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

    // The agent reports each container's raw docker state. An agent older than that
    // field sends "" — and then a restarting container is indistinguishable from a dead
    // one, because all we have is a bool.
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
        /* best-effort: an Inspect failure just leaves the state unknown */
      }
    }

    const containers: RuntimeContainer[] = instances.map((i, idx) => ({
      name: i.name,
      service: i.service,
      state: i.state || (idx === 0 ? legacySoloState : ""),
      health: i.health,
      restartCount: i.restartCount,
      running: i.running,
      exposed: i.exposed,
    }));

    // A compose app declares its services; a single-image one has exactly one,
    // named after the slug. Anything declared with no container on the host is
    // missing — the failure `docker ps` cannot show you.
    const declared = p.compose ? composeServiceNames(p.compose) : [p.slug];
    const present = new Set(containers.map((c) => c.service));
    const missing = declared.filter((s) => !present.has(s));

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

/**
 * Console attach info WITHOUT the shell probe. The client fetches the shell label
 * after mount via `shellLabelAction` and appends the distroless notice lazily if
 * needed.
 */
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

/**
 * Probe the default (running) container's shell label on demand. Backed by the
 * same 5-minute per- container cache as `getAttachInfo`'s probe, so the first call
 * after a deploy pays the probe and later calls are instant.
 */
export async function getShellLabel(
  appId: string,
  target?: string,
): Promise<string> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return "raw exec (no shell)";
  await requireAppCapability(appId, "view");
  // Display-grade list: an unreachable remote degrades to a not-running
  // placeholder, so we return "raw exec (no shell)" below rather than throwing.
  const { instances } = await listInstancesForDisplay(p);
  // A shell can only be probed inside a RUNNING container, so unlike the logs
  // target this one does prefer a running instance over the app's own.
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
  // Default target: the app's own container first, thanks to orderInstances.
  const def = instances[0];
  const running = instances.some((i) => i.running);
  // Probe the default instance's real shell (or lack of one). Only meaningful
  // when running; a stopped/unreachable container can't be probed, so report raw.
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

/** Shell-label probe (via the owning agent) that degrades to raw when unreachable. */
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

/**
 * Authorise an attach request and resolve the real container to attach to. Never
 * trusts a raw container name from the client — the target must belong to this
 * project (same guard as execInContainer).
 */
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
  // Attaching to PID 1 (full-duplex, stdin to the live container) is a
  // deploy-class operation — never available to a view-only member.
  const { teamId } = await requireAppCapability(appId, "open_app_console");
  const p = await loadTeamApp(appId, teamId);
  if (!p) return { ok: false, reason: "not-found" };

  let instances: ConsoleInstance[];
  try {
    instances = await listInstances(p);
  } catch (e) {
    // A remote whose agent is unreachable: fail clearly, never fall back to the
    // local socket (which would attach a foreign/empty container).
    if (e instanceof AgentUnreachableError)
      return { ok: false, reason: "unreachable" };
    throw e;
  }
  const pick = target
    ? instances.find((i) => i.name === target)
    : (instances.find((i) => i.running) ?? instances[0]);
  if (!pick) return { ok: false, reason: "no-instance" };
  // Attaching to a stopped container's PID 1 would just hang — refuse early.
  if (!pick.running) return { ok: false, reason: "stopped" };
  return { ok: true, instance: pick, server: await serverOf(p) };
}

/**
 * Authorise a logs request and resolve the real container to stream. The target
 * must belong to this project; an unknown raw name from the client is rejected.
 */
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
  // Runtime logs are the `view_logs` read (they print whatever the app prints,
  // secrets included). Answered as a REASON rather than a throw: the caller is
  // an SSE route, which turns this into a 403 instead of a 500.
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
  // Default to the app's own container (orderInstances puts it first), NOT to "the
  // first one that happens to be running": when the app is crash-looping, the only
  // running container in the stack is a sidecar, and defaulting to it streams
  const pick = target ? instances.find((i) => i.name === target) : instances[0];
  if (!pick) return { ok: false, reason: "no-instance" };
  return { ok: true, instance: pick, server: await serverOf(p) };
}

export async function execInContainer(
  appId: string,
  rawCommand: string,
  target?: string,
): Promise<{ output: string; detach?: boolean }> {
  // Running arbitrary commands in the live container is RCE — gate on deploy,
  // never bare team membership (a viewer must never reach this).
  const { teamId } = await requireAppCapability(appId, "open_app_console");
  const p = await loadTeamApp(appId, teamId);
  if (!p) return { output: "Error: project not found" };

  const command = rawCommand.trim();
  if (!command) return { output: "" };
  if (command === "exit" || command === "logout")
    return { output: "session closed", detach: true };
  if (command === "clear") return { output: "\f" };

  try {
    const instances = await listInstances(p);
    // Only exec into a container that belongs to this project — never trust a
    // raw name from the client. Fall back to the default target.
    const pick = target
      ? instances.find((i) => i.name === target)
      : instances[0];
    if (!pick) return { output: `! no such instance: ${target}` };

    // Exec on the owning agent (PLAN Part C). The agent applies the same
    // shell/raw dispatch and docker-vs-guest classification, returning the guest
    // exit code; a docker-level failure is a thrown gRPC error (caught below).
    const res = await execOnAgent(p, pick.name, command, pick.image);

    // Docker/OCI-level failure: `docker exec` couldn't run the command at all
    // (container stopped/removed, daemon error, or the exec target binary is missing —
    // e.g. no shell in a distroless image).
    if (isDockerLevelStderr(res.stderr)) {
      const reason =
        res.stderr.trim() || `docker exec failed (exit ${res.code})`;
      return { output: `! ${reason}` };
    }

    // Guest command ran. Show stdout then stderr (stderr is the command's own
    // output, e.g. "sh: gtrger: not found"). Append an exit-code hint only when
    // a non-zero command produced nothing, so a bare failure isn't silent.
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
    // Reject path: spawn failure / timeout / daemon unreachable — docker never
    // produced an exit status. An infrastructure error, not guest output. A
    // remote whose agent is unreachable surfaces here with a clear message.
    if (e instanceof AgentUnreachableError) {
      return { output: `! Server unreachable: ${e.message}` };
    }
    return {
      output: `! ${e instanceof Error ? e.message : "command failed"}`,
    };
  }
}

/** Exec on the owning agent, returning the docker.ts ContainerExecResult shape. */
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
