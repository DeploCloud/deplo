import "server-only";

import { spawn } from "node:child_process";

export interface StreamOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: number;
  /** Written to the child's stdin, which is then closed (e.g. a Dockerfile). */
  input?: string;
}

/**
 * Spawn a process and stream combined stdout+stderr line-by-line to `onLine`.
 * Resolves with the exit code; rejects on spawn error or timeout. Used by the
 * real deploy pipeline so build/clone output reaches the logs as it happens.
 */
export function spawnStream(
  bin: string,
  args: string[],
  onLine: (line: string) => void,
  opts: StreamOpts = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      windowsHide: true,
    });

    if (opts.input != null) {
      child.stdin?.on("error", () => {}); // ignore EPIPE if the child exits early
      child.stdin?.end(opts.input);
    } else {
      child.stdin?.end(); // close stdin so children waiting on it don't hang
    }

    let buf = "";
    const flush = (chunk: Buffer) => {
      buf += chunk.toString();
      let idx: number;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        if (line.length) onLine(line);
        buf = buf.slice(idx + 1);
      }
    };
    child.stdout?.on("data", flush);
    child.stderr?.on("data", flush);

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeout) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${bin} timed out after ${opts.timeout}ms`));
      }, opts.timeout);
    }

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (buf.trim().length) onLine(buf.replace(/\r$/, ""));
      resolve(code ?? 0);
    });
  });
}
