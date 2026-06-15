import "server-only";

import { execFile } from "node:child_process";

/**
 * Real Docker client. Shells out to the `docker` CLI against the mounted
 * /var/run/docker.sock. No shell is used (execFile), so arguments are safe from
 * injection. Every helper throws on non-zero exit; callers decide how to
 * surface failures. This module never fabricates data — if Docker is
 * unavailable the calls reject.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

const DEFAULT_TIMEOUT = 60_000;

/** Run `docker <args>`; rejects on non-zero exit. */
export function docker(
  args: string[],
  opts: { timeout?: number; input?: string; cwd?: string } = {},
): Promise<ExecResult> {
  return run("docker", args, opts);
}

/** Run `docker compose <args>` (v2 plugin). */
export function compose(
  args: string[],
  opts: { timeout?: number; cwd?: string } = {},
): Promise<ExecResult> {
  return run("docker", ["compose", ...args], opts);
}

function run(
  bin: string,
  args: string[],
  opts: { timeout?: number; input?: string; cwd?: string },
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: opts.timeout ?? DEFAULT_TIMEOUT,
        cwd: opts.cwd,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : err
              ? 1
              : 0;
        if (err && code !== 0) {
          reject(
            new Error(
              `${bin} ${args.join(" ")} failed (${code}): ${stderr || err.message}`,
            ),
          );
          return;
        }
        resolve({ stdout, stderr, code });
      },
    );
    if (opts.input && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/** Whether the Docker daemon is reachable. Never throws. */
export async function dockerAvailable(): Promise<boolean> {
  try {
    await docker(["version", "--format", "{{.Server.Version}}"], {
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** Server engine version, or "" if unreachable. */
export async function serverVersion(): Promise<string> {
  try {
    const { stdout } = await docker(
      ["version", "--format", "{{.Server.Version}}"],
      { timeout: 5_000 },
    );
    return stdout.trim();
  } catch {
    return "";
  }
}

/** Parse newline-delimited JSON (docker's `--format '{{json .}}'` output). */
export function parseJsonLines<T>(stdout: string): T[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

export interface ContainerStat {
  name: string;
  cpuPerc: number; // 0-100
  memUsage: number; // bytes
  memLimit: number; // bytes
  memPerc: number;
  netRx: number; // bytes
  netTx: number; // bytes
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
};

function parseSize(s: string): number {
  const m = s.trim().match(/^([\d.]+)\s*([A-Za-z]+)$/);
  if (!m) return 0;
  return parseFloat(m[1]) * (SIZE_UNITS[m[2].toUpperCase()] ?? 1);
}

/** One-shot `docker stats` snapshot for all running containers. */
export async function containerStats(): Promise<ContainerStat[]> {
  const { stdout } = await docker([
    "stats",
    "--no-stream",
    "--format",
    "{{json .}}",
  ]);
  type Raw = {
    Name: string;
    CPUPerc: string;
    MemUsage: string;
    MemPerc: string;
    NetIO: string;
  };
  return parseJsonLines<Raw>(stdout).map((r) => {
    const [usage, limit] = r.MemUsage.split("/").map((x) => parseSize(x));
    const [rx, tx] = r.NetIO.split("/").map((x) => parseSize(x));
    return {
      name: r.Name,
      cpuPerc: parseFloat(r.CPUPerc) || 0,
      memUsage: usage || 0,
      memLimit: limit || 0,
      memPerc: parseFloat(r.MemPerc) || 0,
      netRx: rx || 0,
      netTx: tx || 0,
    };
  });
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string; // running, exited, ...
  status: string;
}

/** List containers (optionally filtered by a label, e.g. deplo.project=<id>). */
export async function listContainers(
  filterLabel?: string,
): Promise<ContainerInfo[]> {
  const args = ["ps", "-a", "--format", "{{json .}}"];
  if (filterLabel) args.push("--filter", `label=${filterLabel}`);
  const { stdout } = await docker(args);
  type Raw = {
    ID: string;
    Names: string;
    Image: string;
    State: string;
    Status: string;
  };
  return parseJsonLines<Raw>(stdout).map((r) => ({
    id: r.ID,
    name: r.Names,
    image: r.Image,
    state: r.State,
    status: r.Status,
  }));
}

/** Tail container logs. */
export async function containerLogs(
  nameOrId: string,
  tail = 200,
): Promise<string> {
  const { stdout, stderr } = await docker([
    "logs",
    "--tail",
    String(tail),
    nameOrId,
  ]);
  // Docker writes app logs to both streams; return them in order-ish.
  return [stdout, stderr].filter(Boolean).join("\n");
}

/** Run a command inside a container (real `docker exec`). */
export async function execInContainer(
  nameOrId: string,
  command: string,
): Promise<ExecResult> {
  return docker(["exec", nameOrId, "sh", "-lc", command], { timeout: 30_000 });
}

/** Ensure the shared external network exists. */
export async function ensureNetwork(name = "deplo"): Promise<void> {
  try {
    await docker(["network", "inspect", name], { timeout: 10_000 });
  } catch {
    await docker(["network", "create", name], { timeout: 15_000 });
  }
}
