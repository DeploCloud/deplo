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
 *
 * Docker named volumes and an app's files dir are host-local, and the agent
 * trust model is strictly star (an agent can neither dial nor trust a peer), so the
 * bytes RELAY through the control plane: the SOURCE agent streams a gzipped tar out
 * (exportVolume / exportFiles), and those chunks feed straight into the DESTINATION
 * agent's importVolume / importFiles (wipe-first, overwriting whatever the freshly-
 * provisioned stack initialised). No S3 hop, no agent↔agent link, no full-archive
 * buffering in the control plane.
 *
 * BOTH stacks must be STOPPED before any copy runs — the destination so nothing
 * writes under the untar, the source so its on-disk state can't change mid-read (a
 * consistent copy). That quiescing is the CALLER's responsibility (it also owns the
 * provision/teardown ordering + rollback); this module is only the byte relay.
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

/** Destroy a stack on a specific server, throwing on failure. `removeVolumes`
 *  (default true) also reclaims the stack's named volumes — used to tear down the
 *  OLD host after a verified copy, or to roll back a half-built NEW stack. Pass
 *  false to leave the volumes intact (a plain `down`) when the data must be
 *  recoverable — e.g. tearing down an old host we BELIEVE is stateless, where a
 *  mis-enumeration should orphan the volume rather than destroy it. */
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
 * the import (destination) can reject; an UNIMPLEMENTED (agent too old) is mapped to
 * a clear "update the agent on the <side> server" error. A non-UNIMPLEMENTED error
 * passes through unchanged either way — we just prefer the source attribution when
 * the error is ambiguous, since the source export is what starts the stream.
 */
function attributeCopyError(e: unknown, what?: string): Error {
  const asSource = mapVolumeCopyUnsupported(e, "source");
  if (asSource.constructor.name === "AgentVolumeCopyUnsupportedError")
    return asSource;
  // A source that is not there is the agent doing its job (it refuses rather than
  // creating an empty volume and calling it a copy) — but it reached the report as
  // `5 NOT_FOUND: … docker: Error response from daemon`, which reads like a broken
  // platform rather than like "nothing ever wrote there". Wording stays neutral:
  // this path serves a server move as well as an import.
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
 * blocks and the gzip trailer. Nothing that holds a byte of real data compresses
 * to anything near this, so a whole export that ends under the ceiling carried
 * nothing, whatever the RPC said.
 */
const EMPTY_ARCHIVE_CEILING = 512;

/**
 * What a copy actually moved. `empty` is the source having had NOTHING to give -
 * told apart from a failure on purpose, because the two want opposite handling:
 * a failure is reported and rolled back, an empty source is a volume nobody ever
 * wrote to and the honest answer is to leave the destination alone.
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
 * Prove the source volume has content BEFORE the destination is touched.
 *
 * `docker run -v <name>:/v` CREATES the named volume when it is missing, so an
 * export of a volume that is not on that host exits 0 with an empty archive - and
 * `ImportVolume` wipes the target before the first frame arrives. That pair turned
 * a wrong source host into total data loss reported as a successful copy (every
 * Dokploy import did exactly this until August 2026). An agent new enough to answer
 * NOT_FOUND refuses first; this probe is what makes the control plane safe on the
 * agents already out there, and it costs one chunk: read until the archive proves
 * itself, then cancel the stream (streamEvents cancels the call on early return).
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
 * connections), overwriting the destination volume. Throws on any failure so the
 * caller can roll the move back.
 *
 * Answers how much it moved rather than nothing at all: a copy that reports success
 * having relayed zero bytes is indistinguishable from one that worked, and that is
 * the shape every silent data loss in this path has taken. The destination is not
 * opened at all until the source has proven it has something to send.
 *
 * `targetName` defaults to the same name, which is what a server MOVE wants: the
 * same stack, re-provisioned on another host, names its volumes identically. It is
 * spelled out only when the two sides genuinely differ — importing a volume from
 * ANOTHER platform, whose naming is not ours (lib/data/dokploy-data.ts).
 */
export async function copyVolumeBetween(
  source: AgentConnection,
  dest: AgentConnection,
  volumeName: string,
  targetName: string = volumeName,
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
      bytes += chunk.length;
      hash.update(chunk);
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
 *
 * Same contract as {@link copyVolumeBetween}, for the same reasons: the source is
 * proven to hold something before the destination is opened, the bytes are counted
 * and hashed, and an empty source is answered rather than performed. The agent
 * refuses a directory that is not there instead of creating one, so `empty` here
 * genuinely means "that directory holds nothing".
 *
 * The CALLER owns the authorization: this reads and writes arbitrary host paths, so
 * it belongs behind instance admin plus the host-volumes grant.
 */
export async function copyHostPathBetween(
  source: AgentConnection,
  dest: AgentConnection,
  sourcePath: string,
  targetPath: string,
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
      bytes += chunk.length;
      hash.update(chunk);
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
 * Copy an app's files dir (a host directory, not a Docker volume) from `source`
 * to `dest`, overwriting the destination. Throws on failure. An app with no files
 * dir on the source streams an empty archive, which just clears the destination dir
 * — a harmless no-op for a move.
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
 *
 * `removeAfter` is true for every caller today. A build server holds no artifacts;
 * the image is a courier and the BuildKit cache is what makes the next build fast,
 * and that is untouched. Throws on failure so the deploy fails BEFORE the target's
 * stack is rewritten, leaving whatever was running still running.
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
 * volume (in order) and, optionally, the files dir. Opens ONE connection to each
 * host and reuses it for the whole set (an app can have several volumes). Throws
 * on the first failure so the caller can roll back — nothing here mutates control-
 * plane state, only agent-side data.
 *
 * `volumeNames` are the FULL host-side Docker volume names (already resolved by the
 * caller — dbVolumeHostName for a DB, buildProjectDescriptor for an app). The
 * caller must have STOPPED both stacks first (see the module comment).
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
