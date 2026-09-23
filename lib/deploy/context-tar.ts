import { spawn } from "node:child_process";

export const CONTEXT_CHUNK_BYTES = 1024 * 1024;

// Streams `dir` as a ustar archive in ~chunkBytes pieces; stopping early kills tar.
export async function* tarDirChunks(
  dir: string,
  chunkBytes = CONTEXT_CHUNK_BYTES,
): AsyncGenerator<Buffer, void, unknown> {
  const child = spawn("tar", ["--format=ustar", "-cf", "-", "-C", dir, "."], {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (s: string) => {
    if (stderr.length < 4096) stderr += s;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  exited.catch(() => {});
  let finished = false;
  try {
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    for await (const piece of child.stdout as AsyncIterable<Buffer>) {
      pending.push(piece);
      pendingBytes += piece.length;
      while (pendingBytes >= chunkBytes) {
        const all = Buffer.concat(pending, pendingBytes);
        yield all.subarray(0, chunkBytes);
        const rest = all.subarray(chunkBytes);
        pending = rest.length ? [rest] : [];
        pendingBytes = rest.length;
      }
    }
    const code = await exited;
    if (code !== 0) {
      throw new Error(
        `tar exited ${code} while archiving build context${stderr ? `: ${stderr.trim()}` : ""}`,
      );
    }
    if (pendingBytes) yield Buffer.concat(pending, pendingBytes);
    finished = true;
  } finally {
    if (!finished && child.exitCode === null) child.kill("SIGKILL");
  }
}

// The whole archive at once, for an agent that predates the streamed upload.
export async function tarDir(dir: string): Promise<Uint8Array> {
  const parts: Buffer[] = [];
  for await (const c of tarDirChunks(dir)) parts.push(c);
  return new Uint8Array(Buffer.concat(parts));
}
