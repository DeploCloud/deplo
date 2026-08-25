import "server-only";

import {
  execFile,
  spawn,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
// node-pty is a native module; it stays out of the bundle via
// serverExternalPackages (next.config.ts) and is rebuilt for the runtime (Node +
// musl) in the Dockerfile.
import type { IPty } from "node-pty";

/**
 * Real Docker client. This module never fabricates data — if Docker is unavailable
 * the calls reject.
 */

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

const DEFAULT_TIMEOUT = 60_000;

interface RunOpts {
  timeout?: number;
  input?: string;
  cwd?: string;
  /**
   * Resolve (instead of reject) when the process exits with a non-zero *exit
   * code*. Spawn failures and timeouts — which produce no numeric exit code,
   * meaning the process never ran — still reject.
   */
  noThrow?: boolean;
}

/** Run `docker <args>`; rejects on non-zero exit. */
export function docker(
  args: string[],
  opts: RunOpts = {},
): Promise<ExecResult> {
  return run("docker", args, opts);
}

/** Run `docker compose <args>` (v2 plugin). */
export function compose(
  args: string[],
  opts: RunOpts = {},
): Promise<ExecResult> {
  return run("docker", ["compose", ...args], opts);
}

function run(bin: string, args: string[], opts: RunOpts): Promise<ExecResult> {
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
        // A numeric `err.code` is a real process exit code. A non-numeric one
        // (ENOENT/EACCES) or a kill (timeout) means the process never produced
        // an exit status — docker itself failed to run — and must always reject.
        const numericExit =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code as number)
            : null;
        if (err && numericExit === null) {
          reject(
            new Error(
              `${bin} ${args.join(" ")} failed: ${stderr || err.message}`,
            ),
          );
          return;
        }
        const code = numericExit ?? 0;
        if (code !== 0 && !opts.noThrow) {
          reject(
            new Error(
              `${bin} ${args.join(" ")} failed (${code}): ${stderr || err?.message}`,
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

/**
 * Whether `docker exec` failed at the docker/OCI runtime level — the command never
 * ran inside the container — as opposed to the guest command running and exiting
 * non-zero.
 */
const DOCKER_LEVEL_STDERR =
  /(?:OCI runtime|unable to start container process|executable file not found in \$PATH|Error response from daemon|No such container|is not running|is paused|Cannot connect to the Docker daemon|cannot exec in a stopped|container .* is (?:not running|paused|restarting)|chdir to cwd .* set in config\.json failed)/m;

export function isDockerLevelStderr(stderr: string): boolean {
  return DOCKER_LEVEL_STDERR.test(stderr ?? "");
}

export type ShellPlan =
  | { kind: "shell"; run: string[] } // argv prefix before the command, e.g. ["sh","-lc"]
  | { kind: "raw" }; // no shell in image — caller's command is split into argv

export interface ContainerExecResult extends ExecResult {
  /** True when no shell was found and the command ran as raw argv (no pipes/globbing). */
  rawMode: boolean;
}

// Shell candidates, most-common first. A login shell (`-lc`) is used to run
// commands (loads PATH/profile) but NOT to probe (a failing profile would perturb
// the probe's exit code).
const SHELL_CANDIDATES: { probe: string[]; run: string[] }[] = [
  { probe: ["sh", "-c", ":"], run: ["sh", "-lc"] },
  { probe: ["bash", "-c", ":"], run: ["bash", "-lc"] },
  { probe: ["ash", "-c", ":"], run: ["ash", "-lc"] },
  { probe: ["busybox", "sh", "-c", ":"], run: ["busybox", "sh", "-c"] },
];

const SHELL_TTL = 5 * 60_000;
const shellCache = new Map<
  string,
  { plan: ShellPlan; image: string; at: number }
>();

/**
 * Determine how to run commands in a container: via a detected shell, or raw argv
 * when the image has none (distroless/scratch).
 */
async function resolveShellPlan(
  name: string,
  image: string,
): Promise<ShellPlan> {
  const hit = shellCache.get(name);
  if (hit && hit.image === image && Date.now() - hit.at < SHELL_TTL)
    return hit.plan;

  let plan: ShellPlan = { kind: "raw" };
  for (const c of SHELL_CANDIDATES) {
    let res: ExecResult;
    try {
      res = await docker(["exec", name, ...c.probe], {
        timeout: 5_000,
        noThrow: true,
      });
    } catch {
      // Spawn failure / timeout / daemon unreachable: can't probe. Don't cache a
      // result that may be transient — treat as raw for this attempt only.
      return { kind: "raw" };
    }
    if (res.code === 0) {
      plan = { kind: "shell", run: c.run };
      break;
    }
    // A docker-level error (container stopped/removed) fails every probe
    // identically — bail without caching so a later restart re-probes.
    if (isDockerLevelStderr(res.stderr)) return { kind: "raw" };
  }
  shellCache.set(name, { plan, image, at: Date.now() });
  return plan;
}

/** Human label for a shell plan, for the prompt/banner. */
export async function shellLabel(name: string, image: string): Promise<string> {
  const plan = await resolveShellPlan(name, image);
  if (plan.kind === "raw") return "raw exec (no shell)";
  return plan.run[0] === "bash" ? "/bin/bash" : "/bin/sh";
}

/**
 * Split a command string into argv for raw (shell-less) exec. Honors single and
 * double quotes; performs NO expansion (no globbing, $VAR, pipes, redirects).
 * Intentionally minimal — this is not a shell emulator.
 */
export function splitArgv(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      has = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (ch === " " || ch === "\t") {
      if (has) {
        out.push(cur);
        cur = "";
        has = false;
      }
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

/**
 * Run a command inside a container (real `docker exec`). Only docker-level
 * failures (spawn error, timeout, daemon unreachable — no numeric exit code)
 * reject.
 */
export async function execInContainer(
  nameOrId: string,
  command: string,
  image: string,
): Promise<ContainerExecResult> {
  const plan = await resolveShellPlan(nameOrId, image);
  if (plan.kind === "shell") {
    const res = await docker(["exec", nameOrId, ...plan.run, command], {
      timeout: 30_000,
      noThrow: true,
    });
    return { ...res, rawMode: false };
  }
  const argv = splitArgv(command);
  if (argv.length === 0)
    return { stdout: "", stderr: "", code: 0, rawMode: true };
  const res = await docker(["exec", nameOrId, ...argv], {
    timeout: 30_000,
    noThrow: true,
  });
  return { ...res, rawMode: true };
}

/**
 * Effective user + working dir from container metadata, via `docker inspect`
 * (needs no shell, so works on distroless).
 */
export async function inspectRuntime(
  name: string,
): Promise<{ user: string; workdir: string }> {
  try {
    const { stdout } = await docker(
      ["inspect", "-f", "{{.Config.User}}\t{{.Config.WorkingDir}}", name],
      { timeout: 10_000 },
    );
    const [user = "", workdir = ""] = stdout.trim().split("\t");
    return { user: user.trim() || "root", workdir: workdir.trim() || "/" };
  } catch {
    return { user: "root", workdir: "/" };
  }
}

/**
 * Whether a container was started with an attachable stdin / a TTY allocated, from
 * `docker inspect`.
 */
export async function inspectStdio(
  name: string,
): Promise<{ openStdin: boolean; tty: boolean }> {
  try {
    const { stdout } = await docker(
      ["inspect", "-f", "{{.Config.OpenStdin}}\t{{.Config.Tty}}", name],
      { timeout: 10_000 },
    );
    const [openStdin = "", tty = ""] = stdout.trim().split("\t");
    return {
      openStdin: openStdin.trim() === "true",
      tty: tty.trim() === "true",
    };
  } catch {
    return { openStdin: false, tty: false };
  }
}

/**
 * Transport-agnostic handle over a live `docker attach`.
 */
export interface AttachHandle {
  /** Subscribe to merged container output; returns an unsubscribe fn. */
  onData(cb: (chunk: Buffer) => void): () => void;
  /**
   * Run `cb` once when the attach client exits (container stop / detach).
   */
  onExit(cb: (error?: string) => void): void;
  /** Send raw bytes to the container's stdin (best-effort; no-op once closed). */
  write(data: string): void;
  /**
   * Resize the backing pseudo-terminal (tty containers only). Optional: the
   * logs backing and pipe-backed attach have no pty to resize, so they omit it
   * and callers guard with `handle.resize?.(cols, rows)`.
   */
  resize?(cols: number, rows: number): void;
  /** Detach: tear down our local attach client only, never the container. */
  close(): void;
}

/**
 * `--sig-proxy=false` is the safety guard shared by both attach backings: killing
 * our local `docker attach` (detach / browser disconnect) never forwards a signal
 * to the container, so the app keeps running.
 */
const ATTACH_ARGS = (name: string) => ["attach", "--sig-proxy=false", name];

/**
 * Pipe-backed attach for containers WITHOUT a TTY (Tty:false).
 */
export function attachContainer(name: string): AttachHandle {
  const child = spawn("docker", ATTACH_ARGS(name), {
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  let closed = false;
  return {
    onData(cb) {
      child.stdout.on("data", cb);
      child.stderr.on("data", cb);
      return () => {
        child.stdout.off("data", cb);
        child.stderr.off("data", cb);
      };
    },
    onExit(cb) {
      child.on("close", cb);
      child.on("error", cb);
    },
    write(data: string) {
      if (closed) return;
      try {
        child.stdin.write(data);
      } catch {
        /* stdin closed by the daemon (no OpenStdin); ignore */
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        child.stdin.end();
      } catch {
        /* already gone */
      }
      // SIGKILL the local attach client only. The container is untouched because
      // sig-proxy is off; this just tears down our side of the stream.
      child.kill("SIGKILL");
    },
  };
}

/**
 * Stream a container's live runtime logs (`docker logs -f`) as an output-only
 * AttachHandle, so the logs viewer reuses the same session/SSE plumbing as attach.
 */
export function followLogs(name: string, tail = 500): AttachHandle {
  const child = spawn("docker", ["logs", "-f", "--tail", String(tail), name], {
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;

  let closed = false;
  return {
    onData(cb) {
      // Apps log to both stdout and stderr; merge them into one stream in the
      // order Docker emits them, same as the one-shot containerLogs tail.
      child.stdout.on("data", cb);
      child.stderr.on("data", cb);
      return () => {
        child.stdout.off("data", cb);
        child.stderr.off("data", cb);
      };
    },
    onExit(cb) {
      child.on("close", cb);
      child.on("error", cb);
    },
    // Logs are read-only — there is no stdin to write to.
    write() {},
    close() {
      if (closed) return;
      closed = true;
      // Kills the local `docker logs -f` client only; the container is untouched.
      child.kill("SIGKILL");
    },
  };
}

/**
 * PTY-backed attach for containers WITH a TTY (Tty:true).
 */
export function attachContainerPty(name: string): AttachHandle {
  // Lazy require: keep the native module off the import path of every docker
  // helper, and surface a clear error only when an interactive attach is asked
  // for on a host where the native build is missing.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const pty = require("node-pty") as typeof import("node-pty");
  const term: IPty = pty.spawn("docker", ATTACH_ARGS(name), {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    // cwd/env inherit the server's; docker resolves the socket from there.
    env: process.env as Record<string, string>,
  });

  let closed = false;
  return {
    onData(cb) {
      // node-pty hands back strings; re-encode to Buffer so the session's
      // StringDecoder handles UTF-8 boundaries uniformly across both backings.
      const sub = term.onData((s) => cb(Buffer.from(s, "utf8")));
      return () => sub.dispose();
    },
    onExit(cb) {
      term.onExit(() => cb());
    },
    write(data: string) {
      if (closed) return;
      try {
        term.write(data);
      } catch {
        /* pty gone; ignore */
      }
    },
    resize(cols: number, rows: number) {
      if (closed) return;
      try {
        term.resize(cols, rows);
      } catch {
        /* pty gone; ignore */
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        // Kills the docker attach client inside the PTY only; sig-proxy=false
        // means the container is never signalled.
        term.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

/** Ensure the shared external network exists. */
export async function ensureNetwork(name = "deplo"): Promise<void> {
  try {
    await docker(["network", "inspect", name], { timeout: 10_000 });
  } catch {
    await docker(["network", "create", name], { timeout: 15_000 });
  }
}
