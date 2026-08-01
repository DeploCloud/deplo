import "server-only";

import { getServerById } from "./servers";
import { requireActiveTeamId, requireCapability } from "../membership";
import { requireFolderCapabilityForApp } from "./folder-access";
import { loadTeamApp } from "./app-graph-load";
import { primaryDomainApp } from "./domains";
import { composeServiceNames } from "../deploy/compose-stack";
import { isDockerLevelStderr } from "../infra/docker";
import {
  connectAgent,
  AgentUnreachableError,
  type AgentConnection,
} from "../infra/agent-client";
import type { App, Server } from "../types";

/**
 * Resolve a project's owning server. Every console/logs surface routes to the
 * agent that owns the project's host (PLAN Part C) — there is no direct-Docker
 * path anymore; the host running Deplo is reached through its agent like any
 * other. An unknown serverId resolves to undefined and the agent dial then fails
 * clearly as unreachable.
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

export function containerName(p: App): string {
  return `deplo-${p.slug}`;
}

/**
 * Every attachable container for a project, default (exposed/running) first —
 * via the owning agent's ListInstances (ordering applied agent-side). There is
 * DELIBERATELY no synthetic fallback: fabricating a container for a host we can't
 * reach would be a "status that lies". An unreachable agent throws
 * {@link AgentUnreachableError} (the caller surfaces a clear error), and a
 * reachable host with no containers truthfully returns [].
 */
export async function listInstances(p: App): Promise<ConsoleInstance[]> {
  // The "exposed" service to flag for ordering now comes from the project's
  // primary domain (the `domains` table is the routing source), not a stored
  // `expose`. Empty for single-image apps / apps with no domain.
  const exposeService = await primaryDomainApp(p.id);
  const conn = await connectAgent(p.serverId);
  try {
    return orderInstances(p, await conn.listInstances(p.id, p.slug, exposeService));
  } finally {
    conn.close();
  }
}

/**
 * Default-target order for a stack: the app's OWN service first, then the
 * Traefik-exposed one, then whatever is running, then alphabetically.
 *
 * Running is deliberately the LAST tiebreak, not the first. The agent orders
 * running containers ahead of stopped ones, which picks the wrong default in the
 * exact case that matters most: a crash-looping app whose Postgres sidecar is
 * healthy would default the console and the log viewer to Postgres, hiding the
 * one container whose output explains the crash.
 */
function orderInstances(p: App, instances: ConsoleInstance[]): ConsoleInstance[] {
  const own = (i: ConsoleInstance) => i.service === p.slug;
  return [...instances].sort((a, b) => {
    if (own(a) !== own(b)) return own(a) ? -1 : 1;
    if (a.exposed !== b.exposed) return a.exposed ? -1 : 1;
    if (a.running !== b.running) return a.running ? -1 : 1;
    return a.service.localeCompare(b.service);
  });
}

/**
 * Container discovery without the shell probe. `getAttachInfo` adds the
 * `shellLabel` probe on top (≤4 `docker exec` calls into the container), which
 * is only needed by the console's "no shell" banner. The Logs page needs just
 * the instance list + running flag, so it uses this lighter call and avoids
 * those exec probes on its render path.
 */
export interface LogsInfo {
  /** At least one container of the app is in docker state "running". */
  running: boolean;
  /**
   * A real container exists on the host, so `docker logs` has output to stream —
   * whether it is running, restarting or long dead. The viewer attaches on THIS,
   * never on `running`: a crash-looping container is precisely the one whose logs
   * you need, and gating the stream on "running" is what hid them.
   */
  streamable: boolean;
  /** The agent could not be reached: the list below is a placeholder, not truth. */
  unreachable: boolean;
  instances: ConsoleInstance[];
}

/**
 * A single honest placeholder instance for the console/logs PAGE render when the
 * real list can't be obtained: a remote whose agent is unreachable, or a reachable
 * remote with zero containers (which returns []). It renders the conventional name
 * with running:false — never fabricating a "running" container — so the page loads
 * and shows "not running / unreachable" instead of 500ing. The OPERATIONAL paths
 * (exec/attach/logs streams) still fail clearly; this is display-only.
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
 * `real` says whether the containers are the host's truth or that placeholder, so
 * callers can tell "nothing to stream from" apart from "a container is down".
 */
async function listInstancesForDisplay(
  p: App,
): Promise<{ instances: ConsoleInstance[]; real: boolean; unreachable: boolean }> {
  try {
    const instances = await listInstances(p);
    return instances.length
      ? { instances, real: true, unreachable: false }
      : { instances: [displayFallback(p)], real: false, unreachable: false };
  } catch (e) {
    if (e instanceof AgentUnreachableError)
      return { instances: [displayFallback(p)], real: false, unreachable: true };
    throw e;
  }
}

export async function getLogsInfo(appId: string): Promise<LogsInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return null;
  await requireFolderCapabilityForApp(appId, "view");
  const found = await listInstancesForDisplay(p);
  return {
    running: found.instances.some((i) => i.running),
    streamable: found.real,
    unreachable: found.unreachable,
    instances: found.instances,
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
   * only answers a running/not-running boolean). Never guess it: "" means
   * unknown, and the UI must say "not running", not invent a reason.
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
 * reporting "active" for an app that has been crash-looping since the deploy.
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
   *
   * The counts above can only see containers that exist, so a service whose
   * container was never created (or was removed) is invisible to them: an app
   * whose only broken container is gone reads as "everything that exists is
   * running", which is how a stack missing its main service still showed Online.
   */
  missing: string[];
  containers: RuntimeContainer[];
  /** The agent could not be reached: the counts are UNKNOWN, not zero. */
  unreachable: boolean;
}

/**
 * The live runtime probe is polled (the app header, the logs page) and several
 * clients can watch the same app at once, so hold each answer briefly to keep a
 * burst of pollers down to one round trip per app. Short enough that a container
 * dying still surfaces within a poll tick.
 */
const RUNTIME_TTL_MS = 3_000;
const runtimeCache = new Map<string, { at: number; value: AppRuntime }>();

export async function getAppRuntime(appId: string): Promise<AppRuntime | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return null;
  await requireFolderCapabilityForApp(appId, "view");

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

    // The agent reports each container's raw docker state. An agent older than
    // that field sends "" — and then a restarting container is indistinguishable
    // from a dead one, because all we have is a bool. For a SINGLE-IMAGE app we
    // can still recover the truth: its container is `deplo-<slug>`, which the
    // older Inspect RPC resolves by name and answers with the raw state. A
    // compose stack's containers (`deplo-<slug>-<service>-N`) are not addressable
    // that way, so against an old agent they stay honestly unknown.
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
 * Console attach info WITHOUT the shell probe. Like `getAttachInfo` but omits
 * the `shellLabel` step (≤4 `docker exec` probes), so the console page renders
 * immediately. The client fetches the shell label after mount via
 * `shellLabelAction` and appends the distroless notice lazily if needed.
 */
export interface ConsoleInfo {
  containerName: string;
  image: string;
  running: boolean;
  instances: ConsoleInstance[];
}

export async function getConsoleInfo(appId: string): Promise<ConsoleInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return null;
  await requireFolderCapabilityForApp(appId, "view");
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
 * Probe the default (running) container's shell label on demand. Authorised
 * like a read of the project's console; returns "raw exec (no shell)" when the
 * container has no shell or isn't running. Backed by the same 5-minute per-
 * container cache as `getAttachInfo`'s probe, so the first call after a deploy
 * pays the probe and later calls are instant.
 */
export async function getShellLabel(
  appId: string,
  target?: string,
): Promise<string> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return "raw exec (no shell)";
  await requireFolderCapabilityForApp(appId, "view");
  // Display-grade list: an unreachable remote degrades to a not-running
  // placeholder, so we return "raw exec (no shell)" below rather than throwing.
  const { instances } = await listInstancesForDisplay(p);
  // A shell can only be probed inside a RUNNING container, so unlike the logs
  // target this one does prefer a running instance over the app's own.
  const pick = target
    ? instances.find((i) => i.name === target)
    : instances.find((i) => i.running) ?? instances[0];
  if (!pick || !pick.running) return "raw exec (no shell)";
  return probeShellLabel(p, pick.name, pick.image);
}

export async function getAttachInfo(appId: string): Promise<AttachInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return null;
  await requireFolderCapabilityForApp(appId, "view");
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
  return { containerName: def.name, image: def.image, running, shell, instances };
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
 * Authorise an attach request and resolve the real container to attach to.
 * Returns the chosen running instance, or a discriminated failure the route can
 * map to a status code. Never trusts a raw container name from the client — the
 * target must belong to this project (same guard as execInContainer).
 */
export async function resolveAttachTarget(
  appId: string,
  target?: string,
): Promise<
  | { ok: true; instance: ConsoleInstance; server: Server | undefined }
  | { ok: false; reason: "not-found" | "no-instance" | "stopped" | "unreachable" }
> {
  // Attaching to PID 1 (full-duplex, stdin to the live container) is a
  // deploy-class operation — never available to a view-only member.
  const { teamId } = await requireCapability("deploy");
  const p = await loadTeamApp(appId, teamId);
  if (!p) return { ok: false, reason: "not-found" };
  await requireFolderCapabilityForApp(appId, "deploy");

  let instances: ConsoleInstance[];
  try {
    instances = await listInstances(p);
  } catch (e) {
    // A remote whose agent is unreachable: fail clearly, never fall back to the
    // local socket (which would attach a foreign/empty container).
    if (e instanceof AgentUnreachableError) return { ok: false, reason: "unreachable" };
    throw e;
  }
  const pick = target
    ? instances.find((i) => i.name === target)
    : instances.find((i) => i.running) ?? instances[0];
  if (!pick) return { ok: false, reason: "no-instance" };
  // Attaching to a stopped container's PID 1 would just hang — refuse early.
  if (!pick.running) return { ok: false, reason: "stopped" };
  return { ok: true, instance: pick, server: await serverOf(p) };
}

/**
 * Authorise a logs request and resolve the real container to stream. Like
 * resolveAttachTarget but does NOT refuse a stopped container — `docker logs`
 * still returns a stopped container's recorded output, so the viewer can show
 * the tail of a crashed/exited container. The target must belong to this
 * project; an unknown raw name from the client is rejected.
 */
export async function resolveLogsTarget(
  appId: string,
  target?: string,
): Promise<
  | { ok: true; instance: ConsoleInstance; server: Server | undefined }
  | { ok: false; reason: "not-found" | "no-instance" | "unreachable" }
> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamApp(appId, teamId);
  if (!p) return { ok: false, reason: "not-found" };
  await requireFolderCapabilityForApp(appId, "view");

  let instances: ConsoleInstance[];
  try {
    instances = await listInstances(p);
  } catch (e) {
    if (e instanceof AgentUnreachableError) return { ok: false, reason: "unreachable" };
    throw e;
  }
  // Default to the app's own container (orderInstances puts it first), NOT to
  // "the first one that happens to be running": when the app is crash-looping,
  // the only running container in the stack is a sidecar, and defaulting to it
  // streams Postgres' logs to someone trying to read their app's stack trace.
  // A stopped / restarting container still has logs — `docker logs` reads the
  // json file, which outlives the process.
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
  const { teamId } = await requireCapability("deploy");
  const p = await loadTeamApp(appId, teamId);
  if (!p) return { output: "Error: project not found" };
  await requireFolderCapabilityForApp(appId, "deploy");

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
    // (container stopped/removed, daemon error, or the exec target binary is
    // missing — e.g. no shell in a distroless image). The exit code can't tell
    // these from a guest non-zero exit (both land on 126 on modern Docker), so
    // classify on the docker/OCI-owned stderr text instead.
    if (isDockerLevelStderr(res.stderr)) {
      const reason = res.stderr.trim() || `docker exec failed (exit ${res.code})`;
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
