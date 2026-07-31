import "server-only";

import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import {
  connectAgent,
  AgentUnreachableError,
  type AgentConnection,
} from "../infra/agent-client";
import { readTarEntry } from "../infra/tar-stream";
import {
  pickBestFavicon,
  scoreFaviconPath,
  isExcludedDirName,
  type FaviconFile,
} from "./favicon-shared";
import { MAX_LOGO_BYTES } from "./logo-shared";

/**
 * Favicon auto-detection for an app whose "source files" live on its OWNING
 * HOST rather than in a repo or an upload — a **compose stack**, whose files dir
 * (`<stacks>/files/<slug>`, the tree every `./x` bind mount in its compose
 * resolves into) is exactly what the Files tab browses and what a static site
 * served by the stack is mounted from.
 *
 * Same logic as the repo/upload detectors, different I/O: the ranking is the
 * shared pure {@link file://./favicon-shared.ts} pick, and only the file listing
 * + the byte read route through the owning server agent (ADR-0006 — the control
 * plane never touches a host, not even its own).
 *
 * Two reads, cheapest first:
 *  1. A BOUNDED breadth-first walk over `ListFiles` (metadata only) collects the
 *     `favicon.*` candidates. An app with no favicon costs nothing beyond this,
 *     which is the common case on every deploy.
 *  2. The winner's bytes. `ReadFile` hands back text and REFUSES binary, so it
 *     only serves an SVG; every other favicon comes out of the `ExportFiles` tar
 *     stream, which is read lazily and cancelled the instant the entry lands
 *     (see {@link file://../infra/tar-stream.ts}).
 *
 * Best-effort otherwise: a missing files dir, an unreadable subdirectory, an
 * agent too old for `files-copy` — all of them just mean "no icon", never an
 * error a deploy has to care about. The single exception is an unreachable
 * server, which is re-raised so the manual action can say so.
 */

/** Directories opened across one walk (each is one RPC round trip). */
const MAX_DIRS_LISTED = 48;
/** How deep below the files root the walk descends (`public/img/icons/…`). */
const MAX_DEPTH = 6;
/** Total entries examined — a hostile/huge tree can't turn this into a crawl. */
const MAX_ENTRIES_SEEN = 20_000;
/** Candidates collected before the walk stops early. */
const MAX_CANDIDATES = 32;
/**
 * Raw archive bytes read from `ExportFiles` before giving up. The stream is
 * cancelled as soon as the wanted entry arrives, so this only bites when the
 * icon sits behind a lot of other data (a media-heavy files dir) — comfortably
 * past any real site's assets, and a hard ceiling on what a cosmetic nicety may
 * cost the host and the wire on a deploy that finds no icon.
 */
const MAX_TAR_SCAN_BYTES = 32 * 1024 * 1024;
/** Hello capability required for the `ExportFiles` stream. */
const FILES_COPY_CAPABILITY = "files-copy";

/** The one agent call the walk needs — narrowed so tests can drive it with a
 * fake tree instead of a live server. `AgentConnection` satisfies it. */
export interface FaviconFileLister {
  listFiles(
    slug: string,
    path: string,
  ): Promise<{ path: string; name: string; kind: string; size: number }[]>;
}

/** The agent calls the byte read needs, narrowed the same way. */
export interface FaviconFileReader {
  readFile(slug: string, path: string): Promise<{ text: string | null; size: number }>;
  hello(): Promise<{ capabilities: string[] }>;
  exportFiles(slug: string): AsyncIterable<Buffer>;
}

/**
 * Walk an app's files dir breadth-first and collect the favicon candidates
 * (path + real size), pruning dependency/build dirs on the way down and
 * stopping at every cap above. Breadth-first on purpose: a real site icon sits
 * at the root or one level in (`public/favicon.ico`), so the shallow levels are
 * always covered even when the budget runs out inside a deep tree.
 *
 * A directory that fails to list is skipped, not fatal — one unreadable subdir
 * must not cost the whole scan.
 */
export async function collectAgentFaviconCandidates(
  lister: FaviconFileLister,
  slug: string,
): Promise<FaviconFile[]> {
  const found: FaviconFile[] = [];
  const queue: { path: string; depth: number }[] = [{ path: "", depth: 0 }];
  let listed = 0;
  let seen = 0;

  while (queue.length > 0 && listed < MAX_DIRS_LISTED && found.length < MAX_CANDIDATES) {
    const dir = queue.shift()!;
    listed++;
    let entries;
    try {
      entries = await lister.listFiles(slug, dir.path);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (++seen > MAX_ENTRIES_SEEN || found.length >= MAX_CANDIDATES) break;
      if (e.kind === "dir") {
        // The agent already resolved symlinks away and reports only dirs/files.
        if (dir.depth + 1 <= MAX_DEPTH && !isExcludedDirName(e.name)) {
          queue.push({ path: e.path, depth: dir.depth + 1 });
        }
      } else if (e.kind === "file" && scoreFaviconPath(e.path) !== null) {
        found.push({ path: e.path, size: e.size });
      }
    }
    if (seen > MAX_ENTRIES_SEEN) break;
  }
  return found;
}

/** Gunzip an agent chunk stream, closing BOTH ends when the consumer stops
 * early — that propagates back through the generator to `stream.cancel()`, so
 * abandoning the read actually stops the agent's tar. */
async function* gunzip(
  chunks: AsyncIterable<Buffer>,
): AsyncGenerator<Uint8Array, void, unknown> {
  const source = Readable.from(chunks);
  const inflated = source.pipe(createGunzip());
  try {
    for await (const chunk of inflated) yield chunk as Uint8Array;
  } finally {
    inflated.destroy();
    source.destroy();
  }
}

/**
 * Read one file out of an app's files dir as raw bytes.
 *
 * An SVG is tried through `ReadFile` first — one small unary call instead of a
 * whole-directory tar, and the only read that works on an agent too old for
 * `files-copy`. It is accepted ONLY when the text round-trips to the exact byte
 * length the agent stat'd: `ReadFile` hands back a UTF-8 string, so a file that
 * isn't valid UTF-8 would come back subtly rewritten, and a re-encoded icon is
 * a corrupted icon. Any mismatch (and every non-SVG) falls through to the
 * `ExportFiles` tar, whose entries the agent writes under a `files/` prefix.
 */
export async function readFilesDirBytes(
  conn: FaviconFileReader,
  slug: string,
  path: string,
): Promise<Buffer | null> {
  if (path.toLowerCase().endsWith(".svg")) {
    // A `reason` (binary / too-large) means the text was withheld — the tar
    // still has the bytes, so fall through rather than give up.
    const file = await conn.readFile(slug, path).catch(() => null);
    if (file?.text) {
      const bytes = Buffer.from(file.text, "utf8");
      if (bytes.length === file.size) return bytes;
    }
  }
  const hello = await conn.hello();
  if (!hello.capabilities?.includes(FILES_COPY_CAPABILITY)) return null;
  return readTarEntry(gunzip(conn.exportFiles(slug)), {
    name: `files/${path}`,
    maxEntryBytes: MAX_LOGO_BYTES,
    maxScanBytes: MAX_TAR_SCAN_BYTES,
  });
}

/** A detected icon: where it was found, and its bytes. */
export interface DetectedFaviconBytes {
  path: string;
  bytes: Buffer;
}

/**
 * Detect a favicon in an app's files dir on its owning server. Null when the
 * app has no files dir yet, no `favicon.*` in it, or the bytes can't be read.
 *
 * The ONE failure it re-raises is {@link AgentUnreachableError}: "the server
 * didn't answer" is not the same answer as "this app has no icon", and the
 * manual "Detect from source" action says so out loud instead of blaming the
 * user's files. Every automatic caller is fire-and-forget and ignores it.
 */
export async function detectAgentFilesFavicon(
  serverId: string,
  slug: string,
): Promise<DetectedFaviconBytes | null> {
  let conn: AgentConnection | undefined;
  try {
    conn = await connectAgent(serverId);
    // Cheapest possible "is there anything to scan": no files dir ⇒ no walk.
    if (!(await conn.filesExist(slug))) return null;
    const candidates = await collectAgentFaviconCandidates(conn, slug);
    // Sizes come from the listing, so the logo cap is applied BEFORE any byte
    // crosses the wire — an oversized favicon is dropped by the ranker.
    const best = pickBestFavicon(candidates);
    if (!best) return null;
    const bytes = await readFilesDirBytes(conn, slug, best.path);
    return bytes && bytes.length > 0 ? { path: best.path, bytes } : null;
  } catch (e) {
    if (e instanceof AgentUnreachableError) throw e;
    return null;
  } finally {
    conn?.close();
  }
}
