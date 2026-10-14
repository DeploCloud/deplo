import "server-only";

import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { createGunzip } from "node:zlib";
import { Readable, Transform, Writable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline as streamPipeline } from "node:stream/promises";
import { join, basename, relative } from "node:path";
import { newId, nowIso } from "../ids";
import { spawnStream } from "../infra/exec";
import { MAX_UPLOAD_BYTES, archiveExt } from "./upload-shared";
import type { UploadArchive } from "../types/app";
import { dataDir } from "../data-dir";

export { MAX_UPLOAD_BYTES, archiveExt };

export const ARCHIVE_TOO_LARGE = "ARCHIVE_TOO_LARGE";

const limits = { bytes: 4 * 1024 * 1024 * 1024, entries: 500_000 };

export function __setExtractLimitsForTest(
  next: Partial<typeof limits>,
): typeof limits {
  const prev = { ...limits };
  Object.assign(limits, next);
  return prev;
}

const EXTRACTED_TOO_LARGE = "archive exceeds the 4 GiB extraction limit";
const TOO_MANY_FILES = "archive holds more than 500,000 files";

function appUploadDir(appId: string): string {
  return join(dataDir(), "uploads", appId);
}

function capBytes(
  maxBytes: number,
  errMsg: string = ARCHIVE_TOO_LARGE,
  measure: (chunk: Buffer) => number = (chunk) => chunk.length,
): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += measure(chunk);
      if (seen > maxBytes) {
        cb(new Error(errMsg));
        return;
      }
      cb(null, chunk);
    },
  });
}

export async function storeUpload(opts: {
  appId: string;
  filename: string;
  ext: string;
  body: ReadableStream<Uint8Array> | null;
}): Promise<UploadArchive> {
  const { appId, filename, ext, body } = opts;
  const id = newId("upl");
  const dir = join(appUploadDir(appId), id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `archive${ext}`);

  try {
    if (body) {
      const nodeBody = body as unknown as NodeReadableStream<Uint8Array>;
      await streamPipeline(
        Readable.fromWeb(nodeBody),
        capBytes(MAX_UPLOAD_BYTES),
        createWriteStream(path),
      );
    } else {
      await streamPipeline(Readable.from([]), createWriteStream(path));
    }
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }

  const { size } = await stat(path);
  return {
    id,
    filename: basename(filename) || `archive${ext}`,
    path,
    size,
    uploadedAt: nowIso(),
  };
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;

// A Deplo move (ADR-0035) puts an app's current archive back under the id its copied row already names.
export async function restoreUpload(opts: {
  appId: string;
  uploadId: string;
  ext: string;
  body: AsyncIterable<Uint8Array>;
}): Promise<{ path: string; size: number }> {
  if (!SAFE_ID.test(opts.appId) || !SAFE_ID.test(opts.uploadId))
    throw new Error("That archive is named in a way Deplo never writes.");
  const dir = join(appUploadDir(opts.appId), opts.uploadId);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const path = join(dir, `archive${opts.ext}`);
  try {
    await streamPipeline(
      Readable.from(opts.body),
      capBytes(MAX_UPLOAD_BYTES),
      createWriteStream(path),
    );
  } catch (err) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
  return { path, size: (await stat(path)).size };
}

export async function pruneUploads(
  appId: string,
  keepId: string,
): Promise<void> {
  const root = appUploadDir(appId);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  await Promise.all(
    entries
      .filter((name) => name !== keepId)
      .map((name) =>
        rm(join(root, name), { recursive: true, force: true }).catch(() => {}),
      ),
  );
}

export async function removeUploads(appId: string): Promise<void> {
  await rm(appUploadDir(appId), { recursive: true, force: true }).catch(
    () => {},
  );
}

export async function extractArchive(
  archive: UploadArchive,
  destDir: string,
  log: (line: string) => void,
): Promise<string> {
  const lower = archive.path.toLowerCase();
  const isZip = lower.endsWith(".zip");
  const isGzip = lower.endsWith(".tar.gz") || lower.endsWith(".tgz");

  try {
    if (isZip) {
      // The sizes in a zip's headers are the uploader's word: count what unzip really inflates first.
      await drainCapped(
        "unzip",
        ["-p", archive.path],
        capBytes(limits.bytes, EXTRACTED_TOO_LARGE),
      );
      await drainCapped(
        "unzip",
        ["-Z1", archive.path],
        capBytes(limits.entries, TOO_MANY_FILES, newlines),
      );
      log(`unzip ${archive.filename}`);
      const code = await spawnStream(
        "unzip",
        ["-q", "-o", archive.path, "-d", destDir],
        log,
        { timeout: 300_000 },
      );
      if (code !== 0) throw new Error(`unzip failed (exit ${code})`);
      await assertTreeWithinBudget(destDir);
    } else {
      log(`tar -x ${archive.filename}`);
      await extractTarBounded(archive, destDir, isGzip, log);
    }

    await rejectSymlinks(destDir);
    return collapseSingleRoot(destDir);
  } catch (err) {
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

async function extractTarBounded(
  archive: UploadArchive,
  destDir: string,
  isGzip: boolean,
  log: (line: string) => void,
): Promise<void> {
  const child = spawn("tar", ["-x", "-v", "-C", destDir], {
    windowsHide: true,
  });
  child.stdin?.on("error", () => {});
  // -v names one member per line, so stdout counts the files as they land.
  let tooMany: unknown = null;
  streamPipeline(
    child.stdout!,
    capBytes(limits.entries, TOO_MANY_FILES, newlines),
    devNull(),
  ).catch((err) => {
    tooMany = err;
    child.kill("SIGKILL");
  });
  let stderr = "";
  child.stderr?.on("data", (c: Buffer) => {
    stderr += c.toString();
    for (const line of c.toString().split("\n")) {
      const t = line.replace(/\r$/, "");
      if (t.trim().length) log(t);
    }
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 300_000);

  const exit = new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", (code) => resolve(code));
  });

  const cap = capBytes(limits.bytes, EXTRACTED_TOO_LARGE);
  const source = createReadStream(archive.path);
  try {
    if (isGzip) {
      await streamPipeline(source, createGunzip(), cap, child.stdin!);
    } else {
      await streamPipeline(source, cap, child.stdin!);
    }
  } catch (err) {
    child.kill("SIGKILL");
    await exit;
    clearTimeout(timer);
    if (timedOut) throw new Error("tar timed out after 300000ms");
    throw tooMany ?? err;
  }

  const code = await exit;
  clearTimeout(timer);
  if (timedOut) throw new Error("tar timed out after 300000ms");
  if (tooMany) throw tooMany;
  if (code !== 0) {
    const detail = stderr.trim().split("\n").pop();
    throw new Error(`tar failed (exit ${code})${detail ? `: ${detail}` : ""}`);
  }
}

const newlines = (chunk: Buffer): number => {
  let n = 0;
  for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) n++;
  return n;
};

const devNull = () =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });

// Reads a command's output through `cap` without writing it anywhere, killing the command when it trips.
async function drainCapped(
  bin: string,
  args: string[],
  cap: Transform,
): Promise<void> {
  const child = spawn(bin, args, {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  const exit = new Promise<void>((resolve) => {
    child.on("error", () => resolve());
    child.on("close", () => resolve());
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, 300_000);
  try {
    await streamPipeline(child.stdout!, cap, devNull());
  } catch (err) {
    child.kill("SIGKILL");
    throw err;
  } finally {
    clearTimeout(timer);
    await exit;
  }
  if (timedOut) throw new Error(`${bin} timed out after 300000ms`);
}

async function assertTreeWithinBudget(dir: string): Promise<void> {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const p = join(current, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else if (e.isFile()) {
        total += (await stat(p)).size;
        if (total > limits.bytes) {
          throw new Error(`${EXTRACTED_TOO_LARGE} (extracted ${total}+ bytes)`);
        }
      }
    }
  }
}

export async function rejectSymlinks(dir: string): Promise<void> {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const p = join(current, e.name);
      if (e.isSymbolicLink()) {
        throw new Error(
          `archive contains a symlink (${relative(dir, p)}); rejected for safety`,
        );
      }
      if (e.isDirectory()) stack.push(p);
    }
  }
}

async function collapseSingleRoot(dir: string): Promise<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return dir;
  }
  if (entries.length === 1 && entries[0].isDirectory()) {
    return join(dir, entries[0].name);
  }
  return dir;
}

export { safeBuildDir } from "./path-safety";
