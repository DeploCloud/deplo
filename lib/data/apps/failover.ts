import "server-only";

import { and, eq } from "drizzle-orm";

import {
  type AppDisk,
  automaticSentence,
  appDisk,
  backupName,
  bindSentence,
  bringBackLabel,
  moveRefusal,
  waitsSentence,
} from "../../apps/failover-copy";
import { getCurrentUser } from "../../auth/current-user";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { clusterMembers } from "../../db/schema/control-plane/clusters";
import { nowIso } from "../../ids";
import { requireActiveTeamId } from "../../membership";
import type { App } from "../../types/app";
import { recordActivity } from "../activity";
import { loadTeamApp } from "../app-graph-load";
import { appRestoreSource, refreshAppBundle } from "../clusters/app-restore";
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
import { getClusterById } from "../clusters/roster";
import { requireFolderCapabilityForApp } from "../folder-access";
import { requireAppCapability } from "../node-access";
import { getServerById } from "../servers/roster";
import { messageOf } from "../../utils";

// How a cluster App that keeps data on its server fails over, and the two things a person can do about it (#204).
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
  /** The opt-in: it moves on its own from its latest backup. */
  automatic: boolean;
  /** What its page says about how it fails over. */
  sentence: string;
  /** Its server stopped answering, and it waits for it. */
  waiting: boolean;
  /** The one click, naming the backup; null when it is not waiting or no other server can read a backup. */
  bringBack: string | null;
  /** Why nothing can bring it back, while it waits. */
  why: string | null;
}

/** What an App that keeps data on a cluster member relies on, as its page states it; null for every other App. */
export async function getAppFailover(id: string): Promise<AppFailover | null> {
  const app = await loadTeamApp(id, await requireActiveTeamId());
  const disk = app ? appDisk(app) : null;
  if (!app?.clusterId || !disk) return null;
  const cluster = await getClusterById(app.clusterId);
  if (!cluster) return null;
  const serverName = (await getServerById(app.serverId))?.name ?? "its server";
  const base = { cluster: cluster.name, serverName, disk, waiting: false };
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
  return {
    ...base,
    waiting,
    automatic: app.failoverFromBackup,
    sentence: app.failoverFromBackup
      ? automaticSentence(app.name)
      : waitsSentence(app.name, serverName),
    bringBack: way?.label ?? null,
    why: way?.why ? `${app.name} cannot be brought back: ${way.why}` : null,
  };
}

/** The opt-in: an App with a Volume moves on its own from its latest backup instead of waiting for its server. */
export async function setAppFailoverFromBackup(
  id: string,
  enabled: boolean,
): Promise<void> {
  const { membership } = await requireAppCapability(id, "configure_apps");
  const user = (await getCurrentUser())!;
  const app = await loadTeamApp(id, membership.teamId);
  if (!app) throw new Error("App not found");
  const disk = appDisk(app);
  if (enabled && disk === "bind")
    throw new Error(
      bindSentence(
        app.name,
        (await getServerById(app.serverId))?.name ?? "its server",
      ),
    );
  if (enabled && disk !== "volume")
    throw new Error(
      `${app.name} keeps no Volume, so a cluster already moves it on its own.`,
    );
  await getDb()
    .update(appsTable)
    .set({ failoverFromBackup: enabled, updatedAt: nowIso() })
    .where(and(eq(appsTable.id, id), eq(appsTable.teamId, membership.teamId)));
  await recordActivity(
    "app",
    `${enabled ? "Turned on" : "Turned off"} failing ${app.name} over automatically from its latest backup`,
    user.name,
    id,
  );
  // The leader holds the backup only while this is on; the sweep sends it again if this does not arrive.
  await refreshAppBundle(id).catch((e) =>
    console.warn(`[failover-bundle] ${id}: ${messageOf(e)}`),
  );
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
