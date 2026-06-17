import "server-only";

import { mkdir, rm, readdir, stat } from "node:fs/promises";
import { createWriteStream } from "node:fs";
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

function projectUploadDir(projectId: string): string {
  return join(UPLOAD_DIR, projectId);
}

/** A Transform that fails the pipeline the instant the byte cap is exceeded. */
function capBytes(maxBytes: number): Transform {
  let seen = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      if (seen > maxBytes) {
        cb(new Error(ARCHIVE_TOO_LARGE));
        return;
      }
      cb(null, chunk);
    },
  });
}

/**
 * Stream an uploaded archive's body to disk and return the pointer to persist
 * on the project. Each upload lands in its OWN subdirectory keyed by its id
 * (`<projectId>/<uploadId>/`) and the project dir is never wiped here — so a
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
  projectId: string;
  filename: string;
  ext: string;
  body: ReadableStream<Uint8Array> | null;
}): Promise<UploadArchive> {
  const { projectId, filename, ext, body } = opts;
  const id = newId("upl");
  const dir = join(projectUploadDir(projectId), id);
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
  projectId: string,
  keepId: string,
): Promise<void> {
  const root = projectUploadDir(projectId);
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
export async function removeUploads(projectId: string): Promise<void> {
  await rm(projectUploadDir(projectId), { recursive: true, force: true }).catch(
    () => {},
  );
}

/**
 * Extract a stored archive into `destDir`, which must already exist. Dispatches
 * on the file extension: tarballs via `tar`, zips via `unzip` (both shipped in
 * the runtime image). Throws on a non-zero exit so the deploy errors clearly.
 *
 * Security: an uploaded archive is fully attacker-controlled, so after the
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

  if (isZip) {
    log(`unzip ${archive.filename}`);
    const code = await spawnStream(
      "unzip",
      ["-q", "-o", archive.path, "-d", destDir],
      log,
      { timeout: 300_000 },
    );
    if (code !== 0) throw new Error(`unzip failed (exit ${code})`);
  } else {
    log(`tar -x ${archive.filename}`);
    const flags = isGzip ? "-xzf" : "-xf";
    const code = await spawnStream(
      "tar",
      [flags, archive.path, "-C", destDir],
      log,
      { timeout: 300_000 },
    );
    if (code !== 0) throw new Error(`tar failed (exit ${code})`);
  }

  await rejectSymlinks(destDir);
  return collapseSingleRoot(destDir);
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
