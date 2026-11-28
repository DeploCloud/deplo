import "server-only";

import { and, eq } from "drizzle-orm";

import { appDisk } from "../../apps/failover-copy";
import { getDb } from "../../db/client";
import { clusterMembers as membersTable } from "../../db/schema/control-plane/clusters";
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
import { QUEUED } from "./copy-turns";
import { recordActivity } from "../activity";

// A move between two members copies the App's data while it runs, and stops it only for the last changes (c44).

/** Vars so tests hurry them: how often a move looks at its new member's copy, and how long it waits at most. */
export const copyAheadWait = { everyMs: 2_000, maxMs: 30 * 60_000 };

const serverName = async (id: string) => (await getServerById(id))?.name ?? id;

/** Why the new member's copy cannot become the App's data on a move; null when both members can and it holds them all. */
async function cannotHandOver(
  app: App,
  from: string,
  to: string,
  names: string[],
): Promise<string | null> {
  const able = await serversReporting(
    [from, to],
    CLUSTER_REPLICAS_MOVE_CAPABILITY,
  );
  const old = [from, to].filter((id) => !able.has(id));
  if (old.length > 0) {
    const who = await Promise.all(old.map(serverName));
    return `the server agent of ${who.join(" and ")} cannot hand a copy over yet`;
  }
  const held = await storedBundle(app.id);
  if (!held) return "Deplo keeps no copy of it yet";
  const copied = restoreDescriptor(app, held.stack).volumeNames;
  const missing = names.filter((n) => !copied.includes(n));
  return missing.length > 0
    ? `its copy on ${await serverName(to)} does not hold ${missing.join(", ")}`
    : null;
}

/** How `to` stopped being a place for the move: it left the cluster, or is being removed from it; null while a member. */
async function leftCluster(
  cluster: Cluster,
  to: string,
): Promise<string | null> {
  const [m] = await getDb()
    .select({ removing: membersTable.emptyingSince })
    .from(membersTable)
    .where(
      and(
        eq(membersTable.clusterId, cluster.id),
        eq(membersTable.serverId, to),
      ),
    )
    .limit(1);
  if (m && !m.removing) return null;
  return m
    ? `is being removed from cluster ${cluster.name}`
    : `left cluster ${cluster.name}`;
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
  if (!held || (await cannotHandOver(app, from, to, []))) return true;
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
  const toName = await serverName(to);
  // c49: a move waited 2 minutes, and another 15 on a dead copy, with nothing on Activity.
  const told = new Set<string>();
  const say = async (what: string, key = what) => {
    if (quick || told.has(key)) return;
    told.add(key);
    await recordActivity("app", `Moving ${app.name} ${what}`, "Deplo", app.id);
  };
  for (;;) {
    // c47: a move towards a member removed meanwhile waited on its copy for 24 minutes.
    const gone = await leftCluster(cluster, to);
    if (gone)
      throw new Error(
        `${toName} ${gone}, so ${app.name} stays on ${await serverName(from)}.`,
      );
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
    // c50: a copy held for its turn kept a move waiting minutes, and Activity said only that it waited.
    const turn = row?.error.startsWith(QUEUED)
      ? row.error.slice(QUEUED.length).trim()
      : "";
    const failed = row?.error && !turn ? row.error : "";
    if (failed)
      await say(
        `still waits: its copy on ${toName} failed (${failed}). Deplo makes it again.`,
      );
    else if (turn)
      await say(`waits for its copy on ${toName}, ${turn}.`, "turn");
    else await say(`waits for its copy on ${toName}.`);
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
 * copied again in 8 s). Otherwise `whole` says why the data is copied whole; null where no copy is kept.
 */
export async function lastChangesOnly(
  app: App,
  names: string[],
  toName: string,
): Promise<
  { moved: { missing: string[]; last: number } } | { whole: string | null }
> {
  const from = app.migrateFromServerId!;
  const to = app.serverId;
  const cluster = app.clusterId ? await getClusterById(app.clusterId) : null;
  if (!cluster?.replicationEnabled || names.length === 0)
    return { whole: null };
  // Never the copy's last row: once the leader places the App there, its agent reports it sending, not synced (c46).
  const why = await cannotHandOver(app, from, to, names);
  if (why) return { whole: why };
  try {
    const conn = await connectAgent(to);
    try {
      const r = await conn.promoteClusterReplica(app.id, from);
      return { moved: { missing: [], last: r.bytes } };
    } finally {
      conn.close();
    }
  } catch (e) {
    return {
      whole: `its copy on ${toName} could not take its last changes (${messageOf(e)})`,
    };
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
