import "server-only";

// https://deplo.build/docs/guides/data/persistent-storage

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

import { connectAgent } from "../infra/agent-client/connect";
import type {
  AgentConnection,
  DroppedEntries,
} from "../infra/agent-client/connection";
import { mapVolumeCopyUnsupported } from "../infra/agent-client/errors";

// Stop a stack on a specific server - a move can't proceed if its data would change under the copy.
export async function stopStackOn(
  serverId: string,
  slug: string,
): Promise<void> {
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.stopStack(slug);
    if (!r.ok) throw new Error(r.error || `agent failed to stop ${slug}`);
  } finally {
    conn.close();
  }
}

// Start a stack on a specific server, throwing on failure.
export async function startStackOn(
  serverId: string,
  slug: string,
): Promise<void> {
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.startStack(slug);
    if (!r.ok) throw new Error(r.error || `agent failed to start ${slug}`);
  } finally {
    conn.close();
  }
}

// Destroy a stack on a specific server; `removeVolumes` also reclaims its named volumes.
export async function destroyStackOn(
  serverId: string,
  slug: string,
  removeVolumes = true,
): Promise<void> {
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.destroyStack(slug, removeVolumes);
    if (!r.ok) throw new Error(r.error || `agent failed to destroy ${slug}`);
  } finally {
    conn.close();
  }
}

function attributeCopyError(e: unknown): Error {
  const asSource = mapVolumeCopyUnsupported(e, "source");
  if (asSource.constructor.name === "AgentVolumeCopyUnsupportedError")
    return asSource;
  return mapVolumeCopyUnsupported(e, "destination");
}

// The agent's refusal to hand over a FILE through the directory export.
export function isNotADirectory(e: unknown): boolean {
  return e instanceof Error && /is a file, not a directory/.test(e.message);
}

function isNotFound(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 5) return true;
  return e instanceof Error && /\b5 NOT_FOUND\b/.test(e.message);
}

// An agent advertising the hardened import ALWAYS reports a digest, so an empty sha256 stops being an answer.
const HARDENED_COPY_CAPABILITY = "volume-copy-hardened";

async function destMustProveTheCopy(dest: AgentConnection): Promise<boolean> {
  try {
    return (
      (await dest.hello()).capabilities?.includes(HARDENED_COPY_CAPABILITY) ===
      true
    );
  } catch {
    return false;
  }
}

const DROP_REPORT_CAPABILITY = "volume-copy.drop-report";

async function hasCapability(
  agent: AgentConnection,
  capability: string,
): Promise<boolean> {
  try {
    return (await agent.hello()).capabilities?.includes(capability) === true;
  } catch {
    return false;
  }
}

const FILE_COPY_CAPABILITY = "host-path-copy.file";

async function carriesOneFile(agent: AgentConnection): Promise<boolean> {
  try {
    return (
      (await agent.hello()).capabilities?.includes(FILE_COPY_CAPABILITY) ===
      true
    );
  } catch {
    return false;
  }
}

function tooOldForFiles(sourcePath: string, which: string): Error {
  return new Error(
    `"${sourcePath}" is a single file, and the server agent on the ${which} host is too old to copy one. Update that server's agent and run the copy again.`,
  );
}

// An agent without `volume-copy.drop-report` answers zeros, so ask the capability, not the counters.
async function droppedNote(
  dest: AgentConnection,
  dropped: DroppedEntries | undefined,
): Promise<string | null> {
  if (!dropped) return null;
  const total = dropped.links + dropped.special;
  if (total === 0) return null;
  if (!(await hasCapability(dest, DROP_REPORT_CAPABILITY))) return null;
  const kinds = [
    dropped.links > 0 &&
      `${dropped.links} link${dropped.links === 1 ? "" : "s"} pointing outside it`,
    dropped.special > 0 &&
      `${dropped.special} device${dropped.special === 1 ? "" : "s"}, socket${dropped.special === 1 ? "" : "s"} or pipe${dropped.special === 1 ? "" : "s"}`,
  ].filter((x): x is string => Boolean(x));
  // The agent reports ONE list of names for both kinds, so a parenthesis after the last kind would mislabel them.
  const named = dropped.names.slice(0, 3).join(", ");
  const which = !named
    ? ""
    : kinds.length === 1
      ? ` (${named})`
      : `, among them ${named}`;
  return `${total} entr${total === 1 ? "y" : "ies"} did not come across: ${kinds.join(" and ")}${which}. Deplo does not copy those - re-create them by hand if the app needs them.`;
}

// What a copy actually moved.
export interface VolumeCopyResult {
  file?: boolean;
  bytes: number;
  sha256: string;
  empty: boolean;
  missing?: boolean;
  dropped?: string | null;
}

// Called with each chunk's size as it crosses; ignored on throw - progress must never fail a copy.
export type OnBytes = (chunkBytes: number) => void;

// A copy somebody cancelled, told apart from a copy that broke.
export class CopyAbortedError extends Error {
  constructor() {
    super("The copy was cancelled.");
    this.name = "CopyAbortedError";
  }
}

export function isCopyAborted(e: unknown): boolean {
  return (
    e instanceof CopyAbortedError || (e as Error)?.name === "CopyAbortedError"
  );
}

function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CopyAbortedError();
}

function report(onBytes: OnBytes | undefined, chunkBytes: number): void {
  try {
    onBytes?.(chunkBytes);
  } catch {
    // A progress line is not worth a copy.
  }
}

// Tar entries that describe the NEXT entry rather than a file of their own.
const TAR_META_TYPES = new Set(["x", "g", "L", "K", "V"]);

const ARCHIVE_ROOTS: ReadonlySet<string> = new Set([".", "./"]);
// A files-dir export is rooted at `files/` (deplo-agent addDirToTar).
const FILES_ROOTS: ReadonlySet<string> = new Set(["files", "files/"]);

// A missing dir exports as a header-only tar, and importing that would WIPE the destination's dir.
export async function filesDirHasContent(
  source: AgentConnection,
  slug: string,
): Promise<boolean> {
  return archiveHasEntries(source.exportFiles(slug), FILES_ROOTS);
}

// Read from the archive's own headers: a size threshold calls a 300-byte file empty.
async function archiveHasEntries(
  stream: AsyncIterable<Uint8Array>,
  roots: ReadonlySet<string> = ARCHIVE_ROOTS,
): Promise<boolean> {
  const src = Readable.from(stream);
  const gunzip = createGunzip();
  src.on("error", (e) => gunzip.destroy(e));
  src.pipe(gunzip);
  let buf = Buffer.alloc(0);
  try {
    for await (const chunk of gunzip) {
      buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
      while (buf.length >= 512) {
        const header = buf.subarray(0, 512);
        // Two zero blocks end an archive; the first is enough to stop reading.
        if (header.every((b) => b === 0)) return false;
        const name = header
          .subarray(0, 100)
          .toString("latin1")
          .replace(/\0.*$/, "");
        const type = String.fromCharCode(header[156] || 0x30);
        if (!TAR_META_TYPES.has(type) && !roots.has(name)) return true;
        const size =
          parseInt(
            header.subarray(124, 136).toString("latin1").replace(/\0.*$/, ""),
            8,
          ) || 0;
        const skip = 512 + Math.ceil(size / 512) * 512;
        if (buf.length < skip) break;
        buf = buf.subarray(skip);
      }
    }
  } finally {
    src.destroy();
    gunzip.destroy();
  }
  return false;
}

// A tar's first headers sit at its front, so the kept head never needs to be large.
const ARCHIVE_HEAD_BYTES = 65_536;

// A head too short to finish reading is not evidence of an empty archive.
async function relayedArchiveHeldEntries(head: Buffer[]): Promise<boolean> {
  try {
    return await archiveHasEntries(
      (async function* () {
        for (const c of head) yield c;
      })(),
    );
  } catch {
    return true;
  }
}

// Prove the source volume has content BEFORE the destination is touched.
async function sourceHasData(
  source: AgentConnection,
  volumeName: string,
): Promise<boolean> {
  return archiveHasEntries(source.exportVolume(volumeName));
}

// Copy ONE named Docker volume between two open agent connections, overwriting the destination.
export async function copyVolumeBetween(
  source: AgentConnection,
  dest: AgentConnection,
  volumeName: string,
  targetName: string = volumeName,
  onBytes?: OnBytes,
  signal?: AbortSignal,
): Promise<VolumeCopyResult> {
  try {
    if (!(await sourceHasData(source, volumeName)))
      return { bytes: 0, sha256: "", empty: true };
  } catch (e) {
    // Nothing there to copy is not a copy that failed: a service that never ran has no data volume yet.
    if (isNotFound(e))
      return { bytes: 0, sha256: "", empty: true, missing: true };
    throw attributeCopyError(e);
  }

  // The digest is the same cross-check the backup relay makes (lib/data/backup-transport.ts).
  const hash = createHash("sha256");
  let bytes = 0;
  const head: Buffer[] = [];
  let headBytes = 0;
  const counted = (async function* () {
    for await (const chunk of source.exportVolume(volumeName)) {
      stopIfAborted(signal);
      bytes += chunk.length;
      hash.update(chunk);
      if (headBytes < ARCHIVE_HEAD_BYTES) {
        head.push(Buffer.from(chunk));
        headBytes += chunk.length;
      }
      report(onBytes, chunk.length);
      yield chunk;
    }
  })();

  let res: {
    ok: boolean;
    error: string;
    bytesWritten?: number;
    sha256?: string;
    dropped?: DroppedEntries;
  };
  // An agent older than these fields answers 0 and "", which is "not reported", never "wrote nothing".
  try {
    res = await dest.importVolume(targetName, true, counted);
  } catch (e) {
    // Ours first: a cancellation must never read as a volume that failed to copy.
    stopIfAborted(signal);
    throw attributeCopyError(e);
  }
  if (!res.ok)
    throw new Error(
      res.error || `agent failed to import the data volume "${targetName}"`,
    );

  const digest = hash.digest("hex");
  // The source proved itself a moment ago, so an empty archive means the export stopped answering.
  if (!(await relayedArchiveHeldEntries(head)))
    throw new Error(
      `nothing was copied out of "${volumeName}" - the volume is empty or no longer on that host`,
    );
  // Load-bearing when reported, because a truncated untar is otherwise invisible.
  if (!res.sha256 && (await destMustProveTheCopy(dest)))
    throw new Error(
      `the copy of "${volumeName}" arrived unverified: the destination host reported no digest`,
    );
  if (res.sha256 && res.sha256 !== digest)
    throw new Error(
      `the copy of "${volumeName}" arrived corrupted: ${bytes} bytes sent, digest ${res.sha256} received instead of ${digest}`,
    );
  if (
    res.bytesWritten != null &&
    res.bytesWritten > 0 &&
    res.bytesWritten !== bytes
  )
    throw new Error(
      `the copy of "${volumeName}" was truncated: ${bytes} bytes sent, ${res.bytesWritten} written`,
    );

  return {
    bytes,
    sha256: digest,
    empty: false,
    dropped: await droppedNote(dest, res.dropped),
  };
}

// Copy one HOST DIRECTORY between two open agent connections - the bind-mount half of a migration.
export async function copyHostPathBetween(
  source: AgentConnection,
  dest: AgentConnection,
  sourcePath: string,
  targetPath: string,
  onBytes?: OnBytes,
  signal?: AbortSignal,
  // Off when the target holds more than this copy - a stack's files dir, where a
  // second bind and Deplo's own File mounts live.
  wipe = true,
): Promise<VolumeCopyResult> {
  // The export refuses a file rather than guessing, and that refusal is the only way to tell the two apart.
  let file = false;
  try {
    if (!(await archiveHasEntries(source.exportHostPath(sourcePath))))
      return { bytes: 0, sha256: "", empty: true };
  } catch (e) {
    if (isNotFound(e))
      return { bytes: 0, sha256: "", empty: true, missing: true };
    if (!isNotADirectory(e)) throw attributeCopyError(e);
    file = true;
    // Asked BEFORE anything is streamed: an older agent would create a DIRECTORY at the target instead.
    if (!(await carriesOneFile(dest)))
      throw tooOldForFiles(sourcePath, "target");
    try {
      if (!(await archiveHasEntries(source.exportHostPath(sourcePath, true))))
        return { bytes: 0, sha256: "", empty: true };
    } catch (again) {
      if (isNotADirectory(again)) throw tooOldForFiles(sourcePath, "source");
      throw attributeCopyError(again);
    }
  }

  const hash = createHash("sha256");
  let bytes = 0;
  const head: Buffer[] = [];
  let headBytes = 0;
  const counted = (async function* () {
    for await (const chunk of source.exportHostPath(sourcePath, file)) {
      stopIfAborted(signal);
      bytes += chunk.length;
      hash.update(chunk);
      if (headBytes < ARCHIVE_HEAD_BYTES) {
        head.push(Buffer.from(chunk));
        headBytes += chunk.length;
      }
      report(onBytes, chunk.length);
      yield chunk;
    }
  })();

  let res: {
    ok: boolean;
    error: string;
    bytesWritten?: number;
    sha256?: string;
    dropped?: DroppedEntries;
  };
  try {
    res = await dest.importHostPath(targetPath, wipe, counted, file);
  } catch (e) {
    stopIfAborted(signal);
    throw attributeCopyError(e);
  }
  if (!res.ok)
    throw new Error(
      res.error || `agent failed to import the directory "${targetPath}"`,
    );

  const digest = hash.digest("hex");
  if (!(await relayedArchiveHeldEntries(head)))
    throw new Error(
      `nothing was copied out of "${sourcePath}" - the directory is empty or no longer on that host`,
    );
  if (!res.sha256 && (await destMustProveTheCopy(dest)))
    throw new Error(
      `the copy of "${sourcePath}" arrived unverified: the destination host reported no digest`,
    );
  if (res.sha256 && res.sha256 !== digest)
    throw new Error(
      `the copy of "${sourcePath}" arrived corrupted: ${bytes} bytes sent, digest ${res.sha256} received instead of ${digest}`,
    );
  if (
    res.bytesWritten != null &&
    res.bytesWritten > 0 &&
    res.bytesWritten !== bytes
  )
    throw new Error(
      `the copy of "${sourcePath}" was truncated: ${bytes} bytes sent, ${res.bytesWritten} written`,
    );

  return {
    bytes,
    sha256: digest,
    empty: false,
    file,
    dropped: await droppedNote(dest, res.dropped),
  };
}

// Copy an app's files dir (a host directory, not a Docker volume), overwriting the destination.
export async function copyFilesBetween(
  source: AgentConnection,
  dest: AgentConnection,
  slug: string,
): Promise<{ empty: boolean }> {
  // Nothing over there means nothing to write here - never a wipe of what the deploy just rendered.
  try {
    if (!(await filesDirHasContent(source, slug))) return { empty: true };
  } catch (e) {
    throw attributeCopyError(e);
  }
  let res: { ok: boolean; error: string };
  try {
    res = await dest.importFiles(slug, true, source.exportFiles(slug));
  } catch (e) {
    throw attributeCopyError(e);
  }
  if (!res.ok)
    throw new Error(
      res.error || `agent failed to import the files dir for "${slug}"`,
    );
  return { empty: false };
}

// Copy a BUILT IMAGE between servers: agents cannot dial each other, so the bytes pass through here.
export async function copyImageBetween(
  source: AgentConnection,
  dest: AgentConnection,
  imageRef: string,
  removeAfter = true,
): Promise<number> {
  let res: { ok: boolean; error: string; bytesWritten: number };
  try {
    res = await dest.importImage(
      imageRef,
      source.exportImage(imageRef, removeAfter),
    );
  } catch (e) {
    throw attributeCopyError(e);
  }
  if (!res.ok)
    throw new Error(
      res.error || `agent failed to load the image "${imageRef}"`,
    );
  return res.bytesWritten;
}

// Migrate a workload's on-host state; the caller must have STOPPED both stacks first.
export async function migrateWorkloadData(
  fromServerId: string,
  toServerId: string,
  opts: { volumeNames: string[]; filesSlug?: string },
): Promise<{ missing: string[] }> {
  const missing: string[] = [];
  const source = await connectAgent(fromServerId);
  try {
    const dest = await connectAgent(toServerId);
    try {
      for (const volume of opts.volumeNames) {
        const res = await copyVolumeBetween(source, dest, volume);
        // Reported, never swallowed: the callers tear the SOURCE down when this returns.
        // No RPC lists volumes, so a wrongly-named one reads as missing, not as a failure.
        if (res.missing) missing.push(volume);
      }
      if (opts.filesSlug) {
        await copyFilesBetween(source, dest, opts.filesSlug);
      }
    } finally {
      dest.close();
    }
  } finally {
    source.close();
  }
  return { missing };
}
