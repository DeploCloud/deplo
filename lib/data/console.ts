import "server-only";

import { read } from "../store";
import { assertUser } from "../auth";
import {
  execInContainer as dockerExec,
  listContainers,
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
  cwd: string;
  user: string;
  shell: string;
}

export function containerName(p: Project): string {
  return `deplo-${p.slug}`;
}

export async function getAttachInfo(projectId: string): Promise<AttachInfo | null> {
  await assertUser();
  const p = read().projects.find((x) => x.id === projectId);
  if (!p) return null;
  let running = false;
  try {
    const cs = await listContainers(`deplo.project=${projectId}`);
    running = cs.some((c) => c.state === "running");
  } catch {
    /* docker unavailable */
  }
  return {
    containerName: containerName(p),
    image: p.dockerImage ?? `deplo/${p.slug}:latest`,
    running,
    cwd: "/app",
    user: "root",
    shell: "/bin/sh",
  };
}

export async function execInContainer(
  projectId: string,
  rawCommand: string,
): Promise<{ output: string; detach?: boolean }> {
  await assertUser();
  const p = read().projects.find((x) => x.id === projectId);
  if (!p) return { output: "Error: project not found" };

  const command = rawCommand.trim();
  if (!command) return { output: "" };
  if (command === "exit" || command === "logout")
    return { output: "detached from container", detach: true };
  if (command === "clear") return { output: "\f" };

  try {
    const res = await dockerExec(containerName(p), command);
    const out = [res.stdout, res.stderr]
      .filter(Boolean)
      .join("\n")
      .replace(/\n+$/, "");
    return { output: out };
  } catch (e) {
    return {
      output: e instanceof Error ? e.message : "command failed",
    };
  }
}
