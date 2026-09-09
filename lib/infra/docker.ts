import "server-only";

import { execFile } from "node:child_process";

/**
 * What is left of the local Docker client: the control plane never touches a
 * host for a per-app action (ADR-0006), so the only caller is the plugin sweep
 * (`lib/plugins/runtime.ts`, dormant - ADR-0013).
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
   * Resolve (instead of reject) on a non-zero *exit code*. Spawn failures and
   * timeouts produce no numeric code - the process never ran - and still reject.
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
        // (ENOENT/EACCES) or a kill (timeout) means docker itself failed to run.
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

/**
 * Whether `docker exec` failed at the docker/OCI runtime level - the command
 * never ran inside the container - rather than the guest command exiting non-zero.
 */
const DOCKER_LEVEL_STDERR =
  /(?:OCI runtime|unable to start container process|executable file not found in \$PATH|Error response from daemon|No such container|is not running|is paused|Cannot connect to the Docker daemon|cannot exec in a stopped|container .* is (?:not running|paused|restarting)|chdir to cwd .* set in config\.json failed)/m;

export function isDockerLevelStderr(stderr: string): boolean {
  return DOCKER_LEVEL_STDERR.test(stderr ?? "");
}

/** Transport-agnostic handle over a live container stream. */
export interface AttachHandle {
  /** Subscribe to merged container output; returns an unsubscribe fn. */
  onData(cb: (chunk: Buffer) => void): () => void;
  /** Run `cb` once when the stream ends (container stop / detach). */
  onExit(cb: (error?: string) => void): void;
  /** Send raw bytes to the container's stdin (best-effort; no-op once closed). */
  write(data: string): void;
  /**
   * Resize the backing pseudo-terminal (tty containers only). Optional - the
   * logs backing has none, so callers guard with `handle.resize?.(cols, rows)`.
   */
  resize?(cols: number, rows: number): void;
  /** Detach: tear down our local client only, never the container. */
  close(): void;
}
