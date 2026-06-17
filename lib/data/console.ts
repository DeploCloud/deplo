import "server-only";

import { read } from "../store";
import { assertUser } from "../auth";
import {
  execInContainer as dockerExec,
  isDockerLevelStderr,
  inspectRuntime,
  inspectStdio,
  listContainers,
  shellLabel,
} from "../infra/docker";
import type { Project } from "../types";

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

export function containerName(p: Project): string {
  return `deplo-${p.slug}`;
}

/**
 * The compose service name embedded in a Compose container name
 * (`deplo-<slug>-<service>-N`). Falls back to the whole name when the pattern
 * does not match (single-image deploys).
 */
function serviceOf(p: Project, containerName: string): string {
  const prefix = `deplo-${p.slug}-`;
  if (containerName.startsWith(prefix)) {
    return containerName.slice(prefix.length).replace(/-\d+$/, "");
  }
  return containerName.replace(/^deplo-/, "");
}

/**
 * Every attachable container for a project, default (exposed/running) first.
 * Returns a single synthetic entry when Docker is unavailable so the console
 * still renders with the conventional name.
 */
export async function listInstances(p: Project): Promise<ConsoleInstance[]> {
  const fallback: ConsoleInstance = {
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
  try {
    const cs = await listContainers(`deplo.project=${p.id}`);
    if (cs.length === 0) return [fallback];
    const instances = await Promise.all(
      cs.map(async (c) => {
        // Both inspects are metadata-only and never throw.
        const [rt, io] = await Promise.all([
          inspectRuntime(c.name),
          inspectStdio(c.name),
        ]);
        return {
          name: c.name,
          service: serviceOf(p, c.name),
          image: c.image,
          running: c.state === "running",
          exposed: p.expose?.service
            ? c.name.includes(`-${p.expose.service}-`)
            : false,
          user: rt.user,
          workdir: rt.workdir,
          openStdin: io.openStdin,
          tty: io.tty,
        };
      }),
    );
    // Exposed app first, then running, then the rest — that is the order the
    // picker shows and the first entry is the default target.
    return instances.sort((a, b) => {
      if (a.exposed !== b.exposed) return a.exposed ? -1 : 1;
      if (a.running !== b.running) return a.running ? -1 : 1;
      return a.service.localeCompare(b.service);
    });
  } catch {
    return [fallback];
  }
}

export async function getAttachInfo(projectId: string): Promise<AttachInfo | null> {
  await assertUser();
  const p = read().projects.find((x) => x.id === projectId);
  if (!p) return null;
  const instances = await listInstances(p);
  // Default target: exposed/running first thanks to listInstances ordering.
  const def = instances[0];
  return {
    containerName: def.name,
    image: def.image,
    running: instances.some((i) => i.running),
    // Probe the default instance's real shell (or lack of one). Only meaningful
    // when running; a stopped container can't be probed, so report raw.
    shell: instances.some((i) => i.running)
      ? await shellLabel(def.name, def.image)
      : "raw exec (no shell)",
    instances,
  };
}

/**
 * Authorise an attach request and resolve the real container to attach to.
 * Returns the chosen running instance, or a discriminated failure the route can
 * map to a status code. Never trusts a raw container name from the client — the
 * target must belong to this project (same guard as execInContainer).
 */
export async function resolveAttachTarget(
  projectId: string,
  target?: string,
): Promise<
  | { ok: true; instance: ConsoleInstance }
  | { ok: false; reason: "not-found" | "no-instance" | "stopped" }
> {
  await assertUser();
  const p = read().projects.find((x) => x.id === projectId);
  if (!p) return { ok: false, reason: "not-found" };

  const instances = await listInstances(p);
  const pick = target
    ? instances.find((i) => i.name === target)
    : instances.find((i) => i.running) ?? instances[0];
  if (!pick) return { ok: false, reason: "no-instance" };
  // Attaching to a stopped container's PID 1 would just hang — refuse early.
  if (!pick.running) return { ok: false, reason: "stopped" };
  return { ok: true, instance: pick };
}

export async function execInContainer(
  projectId: string,
  rawCommand: string,
  target?: string,
): Promise<{ output: string; detach?: boolean }> {
  await assertUser();
  const p = read().projects.find((x) => x.id === projectId);
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
    const res = await dockerExec(pick.name, command, pick.image);

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
    // produced an exit status. An infrastructure error, not guest output.
    return {
      output: `! ${e instanceof Error ? e.message : "command failed"}`,
    };
  }
}
