import "server-only";

import { createHash } from "node:crypto";

import {
  connectAgent,
  mapVolumeCopyUnsupported,
  type AgentConnection,
} from "../infra/agent-client";

/**
 * Cross-host data migration for a server MOVE — the shared relay that both the
 * database move (a single data volume) and the app move (N data volumes + the
 * files dir) build on.
 */

/** Stop a stack on a specific server, throwing on failure (a move can't proceed if
 *  the stack won't quiesce — its data would change under the copy). */
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

/** Start a stack on a specific server, throwing on failure. */
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

/**
 * Destroy a stack on a specific server, throwing on failure. `removeVolumes`
 * (default true) also reclaims the stack's named volumes — used to tear down the
 * OLD host after a verified copy, or to roll back a half-built NEW stack.
 */
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

/**
 * Attribute a copy RPC rejection to the side that failed. The export (source) or
 * the import (destination) can reject; an UNIMPLEMENTED (agent too old) is mapped
 * to a clear "update the agent on the <side> server" error.
 */
function attributeCopyError(e: unknown, what?: string): Error {
  const asSource = mapVolumeCopyUnsupported(e, "source");
  if (asSource.constructor.name === "AgentVolumeCopyUnsupportedError")
    return asSource;
  // A source that is not there is the agent doing its job (it refuses rather than
  // creating an empty volume and calling it a copy) — but it reached the report as `5
  // NOT_FOUND: … docker: Error response from daemon`, which reads like a broken
  if (what && isNotFound(e))
    return new Error(
      `${what} is not on that machine, so nothing was copied. A service that has never run has no data volume yet.`,
    );
  return mapVolumeCopyUnsupported(e, "destination");
}

/** gRPC NOT_FOUND (5), however the error object reaches us. */
function isNotFound(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 5) return true;
  return e instanceof Error && /\b5 NOT_FOUND\b/.test(e.message);
}

/**
 * A gzipped tar of an EMPTY directory is about 45 bytes — a header, two zero
 * blocks and the gzip trailer.
 */
const EMPTY_ARCHIVE_CEILING = 512;

/**
 * What a copy actually moved.
 */
export interface VolumeCopyResult {
  /** Compressed bytes relayed through the control plane. */
  bytes: number;
  /** sha256 of the relayed stream, for the destination's own digest to meet. */
  sha256: string;
  /** The source archive held no files; nothing was written or wiped. */
  empty: boolean;
}

/**
 * Called with each chunk's size as it crosses, for a caller that wants to SAY so
 * while it happens. Deliberately sync and deliberately ignored on throw: a
 * progress line must never be able to fail a copy.
 */
export type OnBytes = (chunkBytes: number) => void;

/**
 * A copy somebody cancelled, told apart from a copy that broke. So the stream
 * itself is interruptible, and this is the shape the interruption takes: never a
 * `failed` line in the report, because nothing failed.
 */
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

/** Throw the moment the caller withdraws. Called once per relayed chunk, which
 *  is roughly once a megabyte - close enough to instant, and free. */
function stopIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CopyAbortedError();
}

/** Report progress without ever letting it fail the copy it is describing. */
function report(onBytes: OnBytes | undefined, chunkBytes: number): void {
  try {
    onBytes?.(chunkBytes);
  } catch {
    // A progress line is not worth a copy.
  }
}

/**
 * Prove the source volume has content BEFORE the destination is touched.
 */
async function sourceHasData(
  source: AgentConnection,
  volumeName: string,
): Promise<boolean> {
  let seen = 0;
  for await (const chunk of source.exportVolume(volumeName)) {
    seen += chunk.length;
    if (seen > EMPTY_ARCHIVE_CEILING) return true;
  }
  return false;
}

/**
 * Copy ONE named Docker volume from `source` to `dest` (both already-open agent
 * connections), overwriting the destination volume.
 */
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
    throw attributeCopyError(e, `The volume "${volumeName}"`);
  }

  // Count and hash what actually crosses. The digest is the same cross-check the
  // backup relay makes (lib/data/backup-transport.ts): an agent that reports its
  // own sha256 back has to meet this one.
  const hash = createHash("sha256");
  let bytes = 0;
  const counted = (async function* () {
    for await (const chunk of source.exportVolume(volumeName)) {
      stopIfAborted(signal);
      bytes += chunk.length;
      hash.update(chunk);
      report(onBytes, chunk.length);
      yield chunk;
    }
  })();

  let res: {
    ok: boolean;
    error: string;
    bytesWritten?: number;
    sha256?: string;
  };
  // Both cross-checks are OPTIONAL by version, not by importance: an agent older
  // than the fields answers 0 and "", which is "not reported" - reading a 0 as
  // "wrote nothing" would fail every copy on the fleet that has not updated yet.
  try {
    res = await dest.importVolume(targetName, true, counted);
  } catch (e) {
    // Ours first: a generator that threw reaches the caller wearing whatever
    // the RPC layer made of it, and a cancellation must never read as a volume
    // that failed to copy.
    stopIfAborted(signal);
    throw attributeCopyError(e);
  }
  if (!res.ok)
    throw new Error(
      res.error || `agent failed to import the data volume "${targetName}"`,
    );

  const digest = hash.digest("hex");
  // The source proved itself a moment ago, so an empty stream here means the export
  // stopped answering between the probe and the copy - never a success.
  if (bytes <= EMPTY_ARCHIVE_CEILING)
    throw new Error(
      `nothing was copied out of "${volumeName}" - the volume is empty or no longer on that host`,
    );
  // Both halves of the digest cross-check are optional until the whole fleet
  // answers them (they are additive StackResult fields); when they are there they
  // are load-bearing, because a truncated untar is otherwise invisible.
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

  return { bytes, sha256: digest, empty: false };
}

/**
 * Copy one HOST DIRECTORY from `source` to `dest` — the bind-mount half of a
 * migration from a platform that keeps service data in a plain directory.
 */
export async function copyHostPathBetween(
  source: AgentConnection,
  dest: AgentConnection,
  sourcePath: string,
  targetPath: string,
  onBytes?: OnBytes,
  signal?: AbortSignal,
): Promise<VolumeCopyResult> {
  let seen = 0;
  try {
    for await (const chunk of source.exportHostPath(sourcePath)) {
      seen += chunk.length;
      if (seen > EMPTY_ARCHIVE_CEILING) break;
    }
  } catch (e) {
    throw attributeCopyError(e, `The directory "${sourcePath}"`);
  }
  if (seen <= EMPTY_ARCHIVE_CEILING)
    return { bytes: 0, sha256: "", empty: true };

  const hash = createHash("sha256");
  let bytes = 0;
  const counted = (async function* () {
    for await (const chunk of source.exportHostPath(sourcePath)) {
      stopIfAborted(signal);
      bytes += chunk.length;
      hash.update(chunk);
      report(onBytes, chunk.length);
      yield chunk;
    }
  })();

  let res: {
    ok: boolean;
    error: string;
    bytesWritten?: number;
    sha256?: string;
  };
  try {
    res = await dest.importHostPath(targetPath, true, counted);
  } catch (e) {
    stopIfAborted(signal);
    throw attributeCopyError(e);
  }
  if (!res.ok)
    throw new Error(
      res.error || `agent failed to import the directory "${targetPath}"`,
    );

  const digest = hash.digest("hex");
  if (bytes <= EMPTY_ARCHIVE_CEILING)
    throw new Error(
      `nothing was copied out of "${sourcePath}" - the directory is empty or no longer on that host`,
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

  return { bytes, sha256: digest, empty: false };
}

/**
 * Copy an app's files dir (a host directory, not a Docker volume) from `source` to
 * `dest`, overwriting the destination.
 */
export async function copyFilesBetween(
  source: AgentConnection,
  dest: AgentConnection,
  slug: string,
): Promise<void> {
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
}

/**
 * Copy a BUILT IMAGE from the server that compiled it to the server that will run
 * it - the build-server relay, and the third use of this module's one idea: agents
 * cannot dial each other, so the bytes pass through the control plane.
 */
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

/**
 * Migrate a workload's full on-host state from one server to another: every named
 * volume (in order) and, optionally, the files dir. The caller must have STOPPED
 * both stacks first (see the module comment).
 */
export async function migrateWorkloadData(
  fromServerId: string,
  toServerId: string,
  opts: { volumeNames: string[]; filesSlug?: string },
): Promise<void> {
  const source = await connectAgent(fromServerId);
  try {
    const dest = await connectAgent(toServerId);
    try {
      for (const volume of opts.volumeNames) {
        await copyVolumeBetween(source, dest, volume);
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
}
