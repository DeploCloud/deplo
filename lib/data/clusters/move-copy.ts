import "server-only";

import { appDisk } from "../../apps/failover-copy";
import { connectAgent } from "../../infra/agent-client/connect";
import { CLUSTER_REPLICAS_MOVE_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import type { App } from "../../types/app";
import type { Cluster } from "../../types/cluster";
import { messageOf } from "../../utils";
import { serversReporting } from "../servers/agent-capabilities";
import { getServerById } from "../servers/roster";
import { restoreDescriptor } from "./app-restore";
import { storedBundle } from "./bundles";
import { volumeSizes } from "./data-size";
import { writableBytes } from "./facts";
import {
  copyReleaseToMembers,
  holdClusterFailoverImages,
  isBuiltImage,
  membersHoldingImage,
} from "./images";
import { following, replicaRows } from "./replica-state";
import {
  AGENT_NO_ROOM,
  NO_ROOM_FOR_COPY,
  noRoomForCopy,
  replicateNow,
} from "./replication";
import { getClusterById } from "./roster";

// A move between two members copies the App's data while it runs, and stops it only for the last changes (c44).

/** Vars so tests hurry them: how often a move looks at its new member's copy, and how long it waits at most. */
export const copyAheadWait = { everyMs: 2_000, maxMs: 30 * 60_000 };

/** The volumes a move may hand over as the new member's copy: both members can, and the copy holds them all. */
export async function copyHolds(
  app: App,
  from: string,
  to: string,
  names: string[],
): Promise<boolean> {
  const able = await serversReporting(
    [from, to],
    CLUSTER_REPLICAS_MOVE_CAPABILITY,
  );
  if (!able.has(from) || !able.has(to)) return false;
  const held = await storedBundle(app.id);
  if (!held) return false;
  const copied = restoreDescriptor(app, held.stack).volumeNames;
  return names.every((n) => copied.includes(n));
}

/**
 * Readies a cluster App's move onto `to` while it still runs: its images there, and a copy of its data there that is
 * whole and follows it. True once the move may go, false when `within` passed first. Throws, before anything
 * changed, when the copy does not fit there.
 */
export async function copyAhead(
  app: App,
  cluster: Cluster,
  to: string,
  opts: { within?: number } = {},
): Promise<boolean> {
  const from = app.serverId;
  if (
    app.clusterId !== cluster.id ||
    from === to ||
    appDisk(app) !== "volume" ||
    !cluster.replicationEnabled
  )
    return true;
  // Nothing sends its changes while it is stopped or its server is off: the stop costs it nothing more.
  if (
    app.status !== "active" ||
    (await getServerById(from))?.status !== "online"
  )
    return true;
  const held = await storedBundle(app.id);
  if (!held || !(await copyHolds(app, from, to, []))) return true;
  // One look, while a person waits: an image still to copy is copied in the background.
  const quick = opts.within === 0;
  const ref = held.stack.imageRef;
  if (
    isBuiltImage(ref) &&
    !(await membersHoldingImage(app.id, ref)).includes(to)
  ) {
    if (quick) return false;
    await copyReleaseToMembers(app.id, ref, from, [to]).catch(() => {});
  }
  if (!quick) await holdClusterFailoverImages(cluster.id).catch(() => {});
  const until = Date.now() + (opts.within ?? copyAheadWait.maxMs);
  for (;;) {
    const row = (await replicaRows([app.id])).find((r) => r.serverId === to);
    if (row && following(row)) return true;
    if (
      row &&
      (row.error.includes(NO_ROOM_FOR_COPY) ||
        row.error.includes(AGENT_NO_ROOM))
    )
      throw new Error(
        `${row.error}, so ${app.name} stays on ${(await getServerById(from))?.name ?? "its server"}.`,
      );
    if (Date.now() >= until) return false;
    await replicateNow(cluster.id);
    await new Promise((r) => setTimeout(r, copyAheadWait.everyMs));
  }
}

/** Why a move did not go: its new member's copy never caught up. */
export async function notCopiedAhead(app: App, to: string): Promise<string> {
  const name = (await getServerById(to))?.name ?? "the new server";
  return `${app.name}'s copy on ${name} did not catch up within ${copyAheadWait.maxMs / 60_000} minutes, so it stays where it runs.`;
}

/**
 * The new member's copy, made while the App ran, takes only what changed since and becomes its data (c44: all 64 MB
 * copied again in 8 s). Null when it cannot, and the data is copied whole.
 */
export async function lastChangesOnly(
  app: App,
  names: string[],
  toName: string,
  emit: (level: "warn", text: string) => void,
): Promise<{ missing: string[]; last: number } | null> {
  const from = app.migrateFromServerId!;
  const to = app.serverId;
  const cluster = app.clusterId ? await getClusterById(app.clusterId) : null;
  if (!cluster?.replicationEnabled || names.length === 0) return null;
  const rows = await replicaRows([app.id]);
  if (!rows.some((r) => r.serverId === to && r.synced)) return null;
  if (!(await copyHolds(app, from, to, names))) return null;
  try {
    const conn = await connectAgent(to);
    try {
      const r = await conn.promoteClusterReplica(app.id, from);
      return { missing: [], last: r.bytes };
    } finally {
      conn.close();
    }
  } catch (e) {
    emit(
      "warn",
      `${app.name}'s copy on ${toName} could not take its last changes (${messageOf(e)}), so its data is copied whole.`,
    );
    return null;
  }
}

/** Why `to` cannot take the App's data now, in the words a copy refused for room uses; null while it can. */
export async function noRoomFor(
  app: App,
  from: string,
  to: string,
  names: string[],
): Promise<string | null> {
  try {
    const conn = await connectAgent(to);
    let disk: { free: number; total: number };
    try {
      const m = await conn.metrics();
      disk = {
        free: writableBytes({
          diskTotal: Number(m.diskTotal),
          diskUsed: Number(m.diskUsed),
          diskPct: m.diskPct,
        }),
        total: Number(m.diskTotal),
      };
    } finally {
      conn.close();
    }
    const { bytes } = await volumeSizes(from, names);
    if (disk.total <= 0 || disk.free - bytes >= disk.total / 10) return null;
    return noRoomForCopy(
      (await getServerById(to))?.name ?? "This server",
      app.name,
      disk.free,
      bytes,
    );
  } catch {
    return null;
  }
}
