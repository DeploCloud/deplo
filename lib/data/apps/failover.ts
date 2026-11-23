import "server-only";

import { and, eq } from "drizzle-orm";

import {
  type AppDisk,
  type CopyRow,
  appDisk,
  copiesLine,
  backupName,
  bindSentence,
  bringBackLabel,
  copyPendingSentence,
  moveRefusal,
  replicatedSentence,
  waitsSentence,
} from "../../apps/failover-copy";
import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { clusterMembers } from "../../db/schema/control-plane/clusters";
import { requireActiveTeamId } from "../../membership";
import type { App } from "../../types/app";
import { recordActivity } from "../activity";
import { loadTeamApp } from "../app-graph-load";
import { appRestoreSource } from "../clusters/app-restore";
import { askLeaderToMove } from "../clusters/bundle-calls";
import {
  type FailoverRestore,
  keyRows,
  leading,
  refreshLeaderKeys,
  sealBundle,
  storedBundle,
} from "../clusters/bundles";
import { backupClock } from "../clusters/failover";
import { leaderHost } from "../clusters/host";
import {
  following,
  replicaRows,
  replicationStates,
  type ReplicaRow,
} from "../clusters/replica-state";
import { clusterOutOfReach, outOfReachSentence } from "../clusters/reach";
import { clusterMemberServerIds, getClusterById } from "../clusters/roster";
import { requireFolderCapabilityForApp } from "../folder-access";
import { requireAppCapability } from "../node-access";
import { getServerById } from "../servers/roster";

// How a cluster App that keeps data on its server fails over: with its cluster's replication, or not at all.
// https://deplo.build/docs/operations/clusters/apps-with-stored-data

const NOT_DEPLOYED =
  "it has not been deployed on its cluster yet, so there is nothing to bring back.";
const NO_BACKUP = "it has no finished backup yet.";

type Way =
  | { restore: FailoverRestore; label: string; when: string; why: null }
  | { restore: null; label: null; when: null; why: string };

/** The backup one click would restore, named as the button names it; or why there is none. */
async function wayBack(app: App): Promise<Way> {
  const none = (why: string): Way => ({
    restore: null,
    label: null,
    when: null,
    why,
  });
  const held = await storedBundle(app.id);
  if (!held) return none(NOT_DEPLOYED);
  const source = await appRestoreSource(app, held.stack);
  if (!source.restore) return none(source.why ?? NO_BACKUP);
  const clock = await backupClock(app.teamId, app.id, source.restore.backupId);
  const when = backupName(
    clock?.startedAt ?? source.restore.takenAt,
    clock?.timezone ?? "UTC",
  );
  return {
    restore: source.restore,
    label: bringBackLabel(app.name, when),
    when,
    why: null,
  };
}

export interface AppFailover {
  cluster: string;
  /** The member it runs on now. */
  serverName: string;
  disk: NonNullable<AppDisk>;
  /** Its cluster copies its data, so it moves on its own. */
  automatic: boolean;
  /** How many other servers keep a copy that follows it now, and when the newest change reached one. */
  replicatedTo: number;
  upToDateAt: string | null;
  /** Other servers that hold a whole copy, following now or not: a failover can use any of them. */
  heldBy: number;
  /** What its page says about how it fails over. */
  sentence: string;
  /** Its server stopped answering, and it waits for it. */
  waiting: boolean;
  /** The one click, naming the backup; null when it is not waiting or no other server can read a backup. */
  bringBack: string | null;
  /** Why nothing can bring it back, while it waits. */
  why: string | null;
  /** "Copies: 2 of 2 up to date", and each other server's copy under Advanced; null without replication. */
  copies: string | null;
  copyRows: CopyRow[];
  /** While no server of its cluster answers Deplo: the sentence that says so; what is above is how it stood then. */
  outOfReach: string | null;
}

/** Each other member's copy of the App, in its page's words. */
export async function copyRows(
  app: { id: string; serverId: string },
  memberIds: string[],
  rows: ReplicaRow[],
  now = Date.now(),
): Promise<CopyRow[]> {
  const out: CopyRow[] = [];
  for (const id of memberIds.filter((m) => m !== app.serverId)) {
    const r = rows.find((x) => x.appId === app.id && x.serverId === id);
    const state: CopyRow["state"] = !r
      ? "Not copied"
      : following(r, now)
        ? "Up to date"
        : r.synced
          ? "Behind"
          : r.connected
            ? "Copying"
            : "Not copied";
    out.push({
      server: (await getServerById(id))?.name ?? id,
      state,
      lastCopyAt: r?.appliedAt ?? null,
      behindSeconds:
        state === "Behind" && r?.appliedAt
          ? Math.round((now - Date.parse(r.appliedAt)) / 1000)
          : null,
      bytes: r?.bytes ?? 0,
      error: r?.error ?? "",
    });
  }
  return out.sort((a, b) => a.server.localeCompare(b.server));
}

/** What an App that keeps data on a cluster member relies on, as its page states it; null for every other App. */
export async function getAppFailover(id: string): Promise<AppFailover | null> {
  const app = await loadTeamApp(id, await requireActiveTeamId());
  const disk = app ? appDisk(app) : null;
  if (!app?.clusterId || !disk) return null;
  const cluster = await getClusterById(app.clusterId);
  if (!cluster) return null;
  const serverName = (await getServerById(app.serverId))?.name ?? "its server";
  const base = {
    cluster: cluster.name,
    serverName,
    disk,
    waiting: false,
    replicatedTo: 0,
    upToDateAt: null,
    heldBy: 0,
    copies: null,
    copyRows: [],
    outOfReach: null as string | null,
  };
  if (disk === "bind")
    return {
      ...base,
      automatic: false,
      sentence: bindSentence(app.name, serverName),
      bringBack: null,
      why: null,
    };
  const [member] = await getDb()
    .select({ state: clusterMembers.leaseState })
    .from(clusterMembers)
    .where(
      and(
        eq(clusterMembers.clusterId, cluster.id),
        eq(clusterMembers.serverId, app.serverId),
      ),
    )
    .limit(1);
  // Fenced: its server has stopped it by now, so a second copy cannot write beside it.
  const waiting = member?.state === "fenced";
  const way = waiting ? await wayBack(app) : null;
  const since = await clusterOutOfReach(cluster.id);
  // Read as of the last time Deplo heard the cluster: a copy is not "behind" for a silence Deplo cannot explain.
  const asOf = since ? Date.parse(since) : Date.now();
  const replicated = cluster.replicationEnabled;
  const memberIds = replicated ? await clusterMemberServerIds(cluster.id) : [];
  const rows = replicated ? await replicaRows([app.id]) : [];
  const [copy] = replicated
    ? await replicationStates(
        [
          {
            id: app.id,
            name: app.name,
            serverId: app.serverId,
            clusterId: cluster.id,
          },
        ],
        new Map([[cluster.id, memberIds]]),
        rows,
        asOf,
      )
    : [];
  const each = replicated ? await copyRows(app, memberIds, rows, asOf) : [];
  return {
    ...base,
    waiting,
    automatic: replicated,
    replicatedTo: copy?.following ?? 0,
    upToDateAt: copy?.upToDateAt ?? null,
    heldBy: copy?.held ?? 0,
    sentence: !replicated
      ? waitsSentence(app.name, serverName, cluster.name)
      : copy?.held
        ? replicatedSentence(app.name)
        : copyPendingSentence(app.name),
    bringBack: way?.label ?? null,
    why: way?.why ? `${app.name} cannot be brought back: ${way.why}` : null,
    copies: replicated ? copiesLine(serverName, each) : null,
    copyRows: each,
    outOfReach: since
      ? `${outOfReachSentence(since)}. This is how ${app.name} stood then.`
      : null,
  };
}

/**
 * The one click on a waiting App: its cluster's leader brings it up on another server from its latest backup.
 * The leader refuses while its own server may still be running it, so there are never two writers.
 */
export async function bringAppBack(id: string): Promise<void> {
  const { membership } = await requireAppCapability(id, "restore_backups");
  await requireFolderCapabilityForApp(id, "restore_backups");
  const user = (await getCurrentUser())!;
  const app = await loadTeamApp(id, membership.teamId);
  if (!app) throw new Error("App not found");
  const cluster = app.clusterId ? await getClusterById(app.clusterId) : null;
  if (!cluster) throw new Error(`${app.name} is not on a cluster.`);
  const disk = appDisk(app);
  if (disk === "bind")
    throw new Error(
      bindSentence(
        app.name,
        (await getServerById(app.serverId))?.name ?? "its server",
      ),
    );
  if (disk !== "volume")
    throw new Error(
      `${app.name} keeps no Volume, so its cluster moves it on its own.`,
    );
  const way = await wayBack(app);
  if (!way.restore)
    throw new Error(`${app.name} cannot be brought back: ${way.why}`);
  const held = (await storedBundle(app.id))!;
  const host = await leaderHost(cluster);
  await refreshLeaderKeys(cluster);
  const key = (await keyRows(cluster.id)).find(leading(cluster));
  if (!host || !key)
    throw new Error(
      "Deplo could not reach the cluster's leader. Try again in a minute.",
    );
  const answer = await askLeaderToMove(host.id, {
    cluster: cluster.id,
    kind: "app",
    id: app.id,
    sealed: await sealBundle({ ...held, restore: way.restore }, key.publicKey),
  });
  if (!answer.ok) throw new Error(moveRefusal(answer.reason, app.name));
  await recordActivity(
    "app",
    `Asked cluster ${cluster.name} to bring ${app.name} back on another server from ${way.when}`,
    user.name,
    app.id,
  );
}
