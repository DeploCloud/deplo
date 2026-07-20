import "server-only";

import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { spawn } from "node:child_process";
import { createGunzip } from "node:zlib";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { pipeline as streamPipeline } from "node:stream/promises";
import { join, basename, relative } from "node:path";
import { newId, nowIso } from "../ids";
import { spawnStream } from "../infra/exec";
import { MAX_UPLOAD_BYTES, archiveExt } from "./upload-shared";
import type { UploadArchive } from "../types";

export { MAX_UPLOAD_BYTES, archiveExt };

const DATA_DIR = process.env.DEPLO_DATA_DIR || "/data";
const UPLOAD_DIR = join(DATA_DIR, "uploads");

/** Thrown by storeUpload when the stream exceeds MAX_UPLOAD_BYTES mid-write. */
export const ARCHIVE_TOO_LARGE = "ARCHIVE_TOO_LARGE";

/**
 * Hard ceiling on the DECOMPRESSED size of an uploaded archive. The compressed
 * upload is already capped at MAX_UPLOAD_BYTES (512 MiB), but that bounds the
 * INPUT, not the output: a decompression bomb can expand a few hundred MiB into
 * hundreds of GB and exhaust the shared control-plane disk/tmpfs while a favicon
 * scan or a build extracts it. 4 GiB comfortably fits any real source tree while
 * refusing a bomb long before it can fill the disk. Keep the "4 GiB" wording in
 * {@link EXTRACTED_TOO_LARGE} in sync if this changes.
 */
const MAX_EXTRACTED_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB

/** Message thrown when an archive would (or did) expand past MAX_EXTRACTED_BYTES. */
const EXTRACTED_TOO_LARGE = "archive exceeds the 4 GiB extraction limit";

function appUploadDir(appId: string): string {
  return join(UPLOAD_DIR, appId);
}

/** A Transform that fails the pipeline the instant the byte cap is exceeded. */
function capBytes(maxBytes: number, errMsg: string = ARCHIVE_TOO_LARGE): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) {
        cb(new Error(errMsg));
        return;
      }
      cb(null, chunk);
    },
  });
}

/**
 * Stream an uploaded archive's body to disk and return the pointer to persist
 * on the project. Each upload lands in its OWN subdirectory keyed by its id
 * (`<appId>/<uploadId>/`) and the project dir is never wiped here — so a
 * fresh upload never deletes a file an in-flight deploy is still extracting,
 * and a rejected upload leaves the previous (working) archive untouched. Call
 * {@link pruneUploads} after the new pointer is committed to drop stale ones.
 *
 * The write is bounded by a streaming byte cap, so an oversized or
 * Content-Length-lying client cannot exhaust the disk: the pipeline aborts and
 * the partial file is removed the moment the cap is crossed (throws
 * {@link ARCHIVE_TOO_LARGE}). Caller validates the extension via
 * {@link archiveExt} first.
 */
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
      // `request.body` is the DOM ReadableStream; Readable.fromWeb wants Node's
      // structurally-identical stream/web type. Cast across the lib boundary.
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
    // streamPipeline destroyed the write stream already; drop the partial file.
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

/**
 * Remove every upload subdir for a project except `keepId`. Called from the
 * route only after the new pointer is committed, so the archive the project now
 * points at is never the one being deleted and a superseded deploy keeps
 * reading its own archive until it (and its subdir) is pruned on the next run.
 */
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
      .map((name) => rm(join(root, name), { recursive: true, force: true }).catch(() => {})),
  );
}

/** Delete a project's stored uploads (used when the project is deleted). */
export async function removeUploads(appId: string): Promise<void> {
  await rm(appUploadDir(appId), { recursive: true, force: true }).catch(
    () => {},
  );
}

/**
 * Extract a stored archive into `destDir`, which must already exist. Dispatches
 * on the file extension: tarballs via `tar`, zips via `unzip` (both shipped in
 * the runtime image). Throws on a non-zero exit so the deploy errors clearly.
 *
 * Security — size: the compressed upload is capped, but decompression is not, so
 * a bomb could expand a few hundred MiB into hundreds of GB and exhaust the
 * shared disk. We bound the DECOMPRESSED size to {@link MAX_EXTRACTED_BYTES}:
 * tarballs are decompressed in-process through a byte cap that aborts the pipe
 * mid-stream (before the bomb hits disk); zips are refused up front when their
 * central-directory uncompressed total already blows the budget, with a
 * post-extract tree measurement as a backstop against a lying directory. On any
 * abort we delete `destDir` so no partial (possibly oversized) tree is left
 * behind (the callers also clean their temp dir, but we don't wait for them).
 *
 * Security — symlinks: an uploaded archive is fully attacker-controlled, so after the
 * extract we walk the tree and REJECT any symbolic link. Left in place, a
 * symlink pointing outside `destDir` (e.g. `ctx -> /`) would let a crafted
 * build context / rootDirectory follow it and bake arbitrary host files —
 * including the shared secrets store — into the user's own image. `tar`'s
 * `..`-stripping and `unzip`'s path checks stop directory traversal, but
 * neither blocks a symlink ENTRY, so we enforce it ourselves.
 *
 * Many archives wrap their contents in a single top-level folder (e.g.
 * `my-app/…` from `git archive` or GitHub's "Download ZIP"). When the extract
 * yields exactly one directory and nothing else, we treat that folder as the
 * project root so build commands and `rootDirectory` resolve against the code,
 * not an empty wrapper.
 */
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
      // Refuse a declared decompression bomb before writing a single byte: the
      // central directory's uncompressed total is cheap to read via `unzip -l`.
      const declared = await zipDeclaredBytes(archive.path);
      if (declared != null && declared > MAX_EXTRACTED_BYTES) {
        throw new Error(`${EXTRACTED_TOO_LARGE} (declares ${declared} bytes)`);
      }
      log(`unzip ${archive.filename}`);
      const code = await spawnStream(
        "unzip",
        ["-q", "-o", archive.path, "-d", destDir],
        log,
        { timeout: 300_000 },
      );
      if (code !== 0) throw new Error(`unzip failed (exit ${code})`);
      // Backstop: a lying central directory can under-report, so measure the
      // extracted tree and reject if it blew past the budget after all.
      await assertTreeWithinBudget(destDir);
    } else {
      log(`tar -x ${archive.filename}`);
      // Drive the decompression ourselves so a gzip bomb is capped DURING
      // extraction (aborted before it can fill the disk), not merely detected
      // once 500 GB has already landed. A plain `.tar` is not a bomb (extracted
      // size <= the capped input) but takes the same bounded path.
      await extractTarBounded(archive, destDir, isGzip, log);
    }

    await rejectSymlinks(destDir);
    return collapseSingleRoot(destDir);
  } catch (err) {
    // Abort path: never leave a partial (possibly oversized) tree on disk.
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Extract a tarball into `destDir` with a hard cap on DECOMPRESSED bytes. We
 * can't trust `tar -xzf` to self-limit, so we read the file, gunzip it in
 * process (when gzipped), run it through {@link capBytes} — which aborts the
 * pipeline the instant it crosses {@link MAX_EXTRACTED_BYTES} — and feed the
 * result to `tar -x` on stdin. A gzip bomb therefore fails mid-stream, before it
 * can fill the shared disk. Throws {@link EXTRACTED_TOO_LARGE} on a cap breach,
 * or a `tar failed` error on a non-zero exit / timeout.
 */
async function extractTarBounded(
  archive: UploadArchive,
  destDir: string,
  isGzip: boolean,
  log: (line: string) => void,
): Promise<void> {
  const child = spawn("tar", ["-x", "-C", destDir], { windowsHide: true });
  child.stdin?.on("error", () => {}); // swallow EPIPE if tar exits first
  child.stdout?.resume(); // drain (tar -x is silent) so it can't backpressure
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

  const cap = capBytes(MAX_EXTRACTED_BYTES, EXTRACTED_TOO_LARGE);
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
    // `err` already carries EXTRACTED_TOO_LARGE on a cap breach (the meaningful
    // failure), or the decompression error otherwise — surface it as-is.
    throw err;
  }

  const code = await exit;
  clearTimeout(timer);
  if (timedOut) throw new Error("tar timed out after 300000ms");
  if (code !== 0) {
    const detail = stderr.trim().split("\n").pop();
    throw new Error(`tar failed (exit ${code})${detail ? `: ${detail}` : ""}`);
  }
}

/**
 * Uncompressed byte total declared by a zip's central directory, read via
 * `unzip -l` (which decompresses nothing). Returns null when the total can't be
 * parsed — the caller then relies on the post-extract backstop instead of
 * blocking a possibly-fine archive. The summary line looks like
 * `   <total>                     <n> files`.
 */
async function zipDeclaredBytes(archivePath: string): Promise<number | null> {
  const lines: string[] = [];
  let code: number;
  try {
    code = await spawnStream("unzip", ["-l", archivePath], (l) => lines.push(l), {
      timeout: 60_000,
    });
  } catch {
    return null;
  }
  if (code !== 0) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\s*(\d+)\s+\d+ files?\s*$/);
    if (m) return Number(m[1]);
  }
  return null;
}

/**
 * Sum the real file sizes under `dir` (symlinks already rejected upstream) and
 * throw {@link EXTRACTED_TOO_LARGE} once the total crosses the budget. Walks
 * iteratively and short-circuits, so a bomb is caught without traversing the
 * whole oversized tree.
 */
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
        if (total > MAX_EXTRACTED_BYTES) {
          throw new Error(`${EXTRACTED_TOO_LARGE} (extracted ${total}+ bytes)`);
        }
      }
    }
  }
}

/**
 * Recursively walk `dir` (via lstat, so links are not followed) and throw on
 * the first symbolic link. Prevents a planted link from surviving into the
 * build, where a user-controlled path could follow it out of the temp dir.
 */
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

/**
 * If `dir` contains exactly one entry and it is a real directory, return that
 * subdirectory; otherwise return `dir` unchanged. Hidden entries count — a
 * lone `__MACOSX` sibling (common in macOS zips) means there is *not* a single
 * clean root, so we leave the dir as-is rather than guess wrong.
 */
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

// `safeBuildDir` (the rootDirectory containment guard) now lives in
// ./path-safety — its own concern, separate from archive streaming, and free of
// `server-only` so the source seam and tests can use it. Re-exported here for
// callers that still import it from this module.
export { safeBuildDir } from "./path-safety";
