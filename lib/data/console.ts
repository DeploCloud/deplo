import "server-only";

import { getServerById } from "./servers";
import { requireActiveTeamId, requireCapability } from "../membership";
import { requireFolderCapabilityForService } from "./folder-access";
import { loadTeamService } from "./service-graph-load";
import { primaryDomainService } from "./domains";
import { isDockerLevelStderr } from "../infra/docker";
import {
  connectAgent,
  AgentUnreachableError,
  type AgentConnection,
} from "../infra/agent-client";
import type { Service, Server } from "../types";

/**
 * Resolve a project's owning server. Every console/logs surface routes to the
 * agent that owns the project's host (PLAN Part C) — there is no direct-Docker
 * path anymore; the host running Deplo is reached through its agent like any
 * other. An unknown serverId resolves to undefined and the agent dial then fails
 * clearly as unreachable.
 */
async function serverOf(p: Service): Promise<Server | undefined> {
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
}

export function containerName(p: Service): string {
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
export async function listInstances(p: Service): Promise<ConsoleInstance[]> {
  // The "exposed" service to flag for ordering now comes from the project's
  // primary domain (the `domains` table is the routing source), not a stored
  // `expose`. Empty for single-image services / services with no domain.
  const exposeService = await primaryDomainService(p.id);
  const conn = await connectAgent(p.serverId);
  try {
    return await conn.listInstances(p.id, p.slug, exposeService);
  } finally {
    conn.close();
  }
}

/**
 * Container discovery without the shell probe. `getAttachInfo` adds the
 * `shellLabel` probe on top (≤4 `docker exec` calls into the container), which
 * is only needed by the console's "no shell" banner. The Logs page needs just
 * the instance list + running flag, so it uses this lighter call and avoids
 * those exec probes on its render path.
 */
export interface LogsInfo {
  running: boolean;
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
function displayFallback(p: Service): ConsoleInstance {
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
  };
}

/** listInstances for a page render: never throws, never empty — degrades to a
 *  single honest, not-running placeholder so the console/logs page always loads. */
async function listInstancesForDisplay(p: Service): Promise<ConsoleInstance[]> {
  try {
    const instances = await listInstances(p);
    return instances.length ? instances : [displayFallback(p)];
  } catch (e) {
    if (e instanceof AgentUnreachableError) return [displayFallback(p)];
    throw e;
  }
}

export async function getLogsInfo(serviceId: string): Promise<LogsInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamService(serviceId, teamId);
  if (!p) return null;
  const instances = await listInstancesForDisplay(p);
  return { running: instances.some((i) => i.running), instances };
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

export async function getConsoleInfo(serviceId: string): Promise<ConsoleInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamService(serviceId, teamId);
  if (!p) return null;
  const instances = await listInstancesForDisplay(p);
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
  serviceId: string,
  target?: string,
): Promise<string> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamService(serviceId, teamId);
  if (!p) return "raw exec (no shell)";
  // Display-grade list: an unreachable remote degrades to a not-running
  // placeholder, so we return "raw exec (no shell)" below rather than throwing.
  const instances = await listInstancesForDisplay(p);
  const pick = target
    ? instances.find((i) => i.name === target)
    : instances.find((i) => i.running) ?? instances[0];
  if (!pick || !pick.running) return "raw exec (no shell)";
  return probeShellLabel(p, pick.name, pick.image);
}

export async function getAttachInfo(serviceId: string): Promise<AttachInfo | null> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamService(serviceId, teamId);
  if (!p) return null;
  const instances = await listInstancesForDisplay(p);
  // Default target: exposed/running first thanks to listInstances ordering.
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
  p: Service,
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
  serviceId: string,
  target?: string,
): Promise<
  | { ok: true; instance: ConsoleInstance; server: Server | undefined }
  | { ok: false; reason: "not-found" | "no-instance" | "stopped" | "unreachable" }
> {
  // Attaching to PID 1 (full-duplex, stdin to the live container) is a
  // deploy-class operation — never available to a view-only member.
  const { teamId } = await requireCapability("deploy");
  const p = await loadTeamService(serviceId, teamId);
  if (!p) return { ok: false, reason: "not-found" };
  await requireFolderCapabilityForService(serviceId, "deploy");

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
  serviceId: string,
  target?: string,
): Promise<
  | { ok: true; instance: ConsoleInstance; server: Server | undefined }
  | { ok: false; reason: "not-found" | "no-instance" | "unreachable" }
> {
  const teamId = await requireActiveTeamId();
  const p = await loadTeamService(serviceId, teamId);
  if (!p) return { ok: false, reason: "not-found" };

  let instances: ConsoleInstance[];
  try {
    instances = await listInstances(p);
  } catch (e) {
    if (e instanceof AgentUnreachableError) return { ok: false, reason: "unreachable" };
    throw e;
  }
  const pick = target
    ? instances.find((i) => i.name === target)
    : instances.find((i) => i.running) ?? instances[0];
  if (!pick) return { ok: false, reason: "no-instance" };
  return { ok: true, instance: pick, server: await serverOf(p) };
}

export async function execInContainer(
  serviceId: string,
  rawCommand: string,
  target?: string,
): Promise<{ output: string; detach?: boolean }> {
  // Running arbitrary commands in the live container is RCE — gate on deploy,
  // never bare team membership (a viewer must never reach this).
  const { teamId } = await requireCapability("deploy");
  const p = await loadTeamService(serviceId, teamId);
  if (!p) return { output: "Error: project not found" };
  await requireFolderCapabilityForService(serviceId, "deploy");

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
  p: Service,
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
