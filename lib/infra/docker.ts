import "server-only";

import { execFile } from "node:child_process";

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
  noThrow?: boolean;
}

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

const DOCKER_LEVEL_STDERR =
  /(?:OCI runtime|unable to start container process|executable file not found in \$PATH|Error response from daemon|No such container|is not running|is paused|Cannot connect to the Docker daemon|cannot exec in a stopped|container .* is (?:not running|paused|restarting)|chdir to cwd .* set in config\.json failed)/m;

export function isDockerLevelStderr(stderr: string): boolean {
  return DOCKER_LEVEL_STDERR.test(stderr ?? "");
}

export interface AttachHandle {
  onData(cb: (chunk: Buffer) => void): () => void;
  onExit(cb: (error?: string) => void): void;
  write(data: string): void;
  resize?(cols: number, rows: number): void;
  close(): void;
}
