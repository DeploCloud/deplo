import "server-only";

import { execFile } from "node:child_process";
import { spawnStream } from "./exec";

/** Resolve the commit SHA a remote branch currently points at. */
export function lsRemote(url: string, branch: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["ls-remote", url, branch],
      { timeout: 30_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        const sha = stdout.split(/\s+/)[0]?.trim() ?? "";
        resolve(sha);
      },
    );
  });
}

/** The HEAD commit SHA of a local clone. */
export function revParse(dir: string): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", dir, "rev-parse", "HEAD"],
      { timeout: 10_000, windowsHide: true },
      (err, stdout) => resolve(err ? "" : stdout.trim()),
    );
  });
}

/** Shallow-clone a branch into `dir`, streaming output to `onLine`. */
export async function cloneStream(
  url: string,
  branch: string,
  dir: string,
  onLine: (line: string) => void,
): Promise<void> {
  const code = await spawnStream(
    "git",
    ["clone", "--depth", "1", "--branch", branch, "--single-branch", url, dir],
    onLine,
    { timeout: 300_000 },
  );
  if (code !== 0) throw new Error(`git clone failed (exit ${code})`);
}
