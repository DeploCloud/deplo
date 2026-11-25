import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { BackupKind, RestoreRequest } from "../../agent/gen/agent";
import type { ProjectDescriptor } from "../../agent/gen/agent";
import { appDisk } from "../../apps/failover-copy";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterAppReplicas,
  clusterMembers,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { nowIso } from "../../ids";
import { requireActiveTeamId } from "../../membership";
import { loadAppGraph } from "../app-graph-load";
import type { FailoverRestore } from "./bundles";
import { clusterOutOfReach } from "./reach";

// How replication stands, as the server agents last said (ADR-0046), and the restore a failover runs from a copy.

/** The backup id the leader is handed for a restore from a copy; no backup run is ever named so. */
export const REPLICA_ID = "replica";

export const isReplicaId = (id: unknown): boolean => id === REPLICA_ID;

/** A copy that heard nothing from the App's server for this long has fallen behind. */
export const BEHIND_AFTER_MS = 30_000;

/** A copy's status Deplo read longer ago than this says nothing of now: it is judged by its age at Deplo's clock. */
export const REPORT_FRESH_MS = 2 * 60_000;

export type ReplicaRow = typeof clusterAppReplicas.$inferSelect;

export async function replicaRows(appIds: string[]): Promise<ReplicaRow[]> {
  if (appIds.length === 0) return [];
  return getDb()
    .select()
    .from(clusterAppReplicas)
    .where(inArray(clusterAppReplicas.appId, appIds));
}

/** A copy on another server than the one the App runs on, whole once: a failover can put it in place. */
export function promotable(
  rows: ReplicaRow[],
  app: { id: string; serverId: string },
): boolean {
  return rows.some(
    (r) => r.appId === app.id && r.serverId !== app.serverId && r.synced,
  );
}

/**
 * A copy that is whole and heard from the App's server, as its own server said when Deplo last asked: a pass that
 * comes late is not a copy behind (c38: every copy read Behind for about 35 s while each pass took longer under load).
 */
export function following(r: ReplicaRow, now = Date.now()): boolean {
  if (r.role !== "receiving" || !r.synced || !r.connected || !r.appliedAt)
    return false;
  const read = Date.parse(r.checkedAt);
  const at = now - read < REPORT_FRESH_MS ? read : now;
  return at - Date.parse(r.appliedAt) < BEHIND_AFTER_MS;
}

/**
 * What a member runs before a moved App starts: the copy replication kept there takes the place of its data. It
 * names no member: one without a whole copy refuses, and the leader tries the next.
 */
export function replicaRestore(project: ProjectDescriptor): FailoverRestore {
  return {
    backupId: REPLICA_ID,
    takenAt: nowIso(),
    request: RestoreRequest.toJSON({
      kind: BackupKind.BACKUP_KIND_PROJECT,
      project,
      fromReplica: true,
      ageIdentity: "",
      expectedSha256: "",
      logPrefix: "",
      memberFingerprint: "",
    }),
  };
}

export interface AppReplicationState {
  appId: string;
  appName: string;
  /** Other servers whose copy is whole and up to date now. */
  following: number;
  /** Other servers that hold a whole copy, up to date or not. */
  held: number;
  /** Other servers of the cluster, which all keep one. */
  total: number;
  /** When the newest change reached a copy that follows; null while none does. */
  upToDateAt: string | null;
  /** Why a copy does not follow, as its server says; empty when every one does. */
  error: string;
}

/** Replication of the given Apps as their pages read it. Internal: callers hold the gates. */
export function replicationStates(
  apps: { id: string; name: string; serverId: string; clusterId: string }[],
  memberIds: Map<string, string[]>,
  rows: ReplicaRow[],
  now = Date.now(),
): AppReplicationState[] {
  return apps.map((a) => {
    const others = (memberIds.get(a.clusterId) ?? []).filter(
      (m) => m !== a.serverId,
    );
    const mine = rows.filter(
      (r) => r.appId === a.id && others.includes(r.serverId),
    );
    const live = mine.filter((r) => following(r, now));
    const newest = live
      .map((r) => r.appliedAt!)
      .sort()
      .at(-1);
    return {
      appId: a.id,
      appName: a.name,
      following: live.length,
      held: mine.filter((r) => r.synced).length,
      total: others.length,
      upToDateAt: newest ?? null,
      error: mine.find((r) => !following(r, now) && r.error)?.error ?? "",
    };
  });
}

/**
 * The active team's Apps with stored data on this cluster, and how far replication has got for each; empty while
 * replication is off. Nothing here asks a server.
 */
export async function listClusterReplication(
  clusterId: string,
): Promise<AppReplicationState[]> {
  const teamId = await requireActiveTeamId();
  const [cluster] = await getDb()
    .select({ on: clustersTable.replicationEnabled })
    .from(clustersTable)
    .where(eq(clustersTable.id, clusterId))
    .limit(1);
  if (!cluster?.on) return [];
  const rows = await getDb()
    .select({ id: appsTable.id })
    .from(appsTable)
    .where(
      and(eq(appsTable.clusterId, clusterId), eq(appsTable.teamId, teamId)),
    );
  const apps = [];
  for (const r of rows) {
    const app = await loadAppGraph(r.id);
    if (app?.clusterId && appDisk(app) === "volume")
      apps.push({
        id: app.id,
        name: app.name,
        serverId: app.serverId,
        clusterId: app.clusterId,
      });
  }
  const members = await getDb()
    .select({ id: clusterMembers.serverId })
    .from(clusterMembers)
    .where(eq(clusterMembers.clusterId, clusterId));
  // Out of reach, the copies read as they stood when Deplo last heard the cluster: a silence is no copy falling behind.
  const since = await clusterOutOfReach(clusterId);
  return replicationStates(
    apps,
    new Map([[clusterId, members.map((m) => m.id)]]),
    await replicaRows(apps.map((a) => a.id)),
    since ? Date.parse(since) : Date.now(),
  ).sort((a, b) => a.appName.localeCompare(b.appName));
}
