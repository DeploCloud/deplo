import "server-only";

import {
  connectAgent,
  mapVolumeCopyUnsupported,
  type AgentConnection,
} from "../infra/agent-client";

/**
 * Cross-host data migration for a server MOVE — the shared relay that both the
 * database move (a single data volume) and the service move (N data volumes + the
 * files dir) build on.
 *
 * Docker named volumes and a service's files dir are host-local, and the agent
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
export async function stopStackOn(serverId: string, slug: string): Promise<void> {
  const conn = await connectAgent(serverId);
  try {
    const r = await conn.stopStack(slug);
    if (!r.ok) throw new Error(r.error || `agent failed to stop ${slug}`);
  } finally {
    conn.close();
  }
}

/** Start a stack on a specific server, throwing on failure. */
export async function startStackOn(serverId: string, slug: string): Promise<void> {
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
function attributeCopyError(e: unknown): Error {
  const asSource = mapVolumeCopyUnsupported(e, "source");
  if (asSource.constructor.name === "AgentVolumeCopyUnsupportedError") return asSource;
  return mapVolumeCopyUnsupported(e, "destination");
}

/**
 * Copy ONE named Docker volume from `source` to `dest` (both already-open agent
 * connections), overwriting the destination volume. Throws on any failure so the
 * caller can roll the move back.
 */
export async function copyVolumeBetween(
  source: AgentConnection,
  dest: AgentConnection,
  volumeName: string,
): Promise<void> {
  let res: { ok: boolean; error: string };
  try {
    res = await dest.importVolume(volumeName, true, source.exportVolume(volumeName));
  } catch (e) {
    throw attributeCopyError(e);
  }
  if (!res.ok)
    throw new Error(
      res.error || `agent failed to import the data volume "${volumeName}"`,
    );
}

/**
 * Copy a service's files dir (a host directory, not a Docker volume) from `source`
 * to `dest`, overwriting the destination. Throws on failure. A service with no files
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
    throw new Error(res.error || `agent failed to import the files dir for "${slug}"`);
}

/**
 * Migrate a workload's full on-host state from one server to another: every named
 * volume (in order) and, optionally, the files dir. Opens ONE connection to each
 * host and reuses it for the whole set (a service can have several volumes). Throws
 * on the first failure so the caller can roll back — nothing here mutates control-
 * plane state, only agent-side data.
 *
 * `volumeNames` are the FULL host-side Docker volume names (already resolved by the
 * caller — dbVolumeHostName for a DB, buildProjectDescriptor for a service). The
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
