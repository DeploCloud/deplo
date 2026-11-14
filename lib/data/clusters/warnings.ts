import "server-only";

import { asc, count, eq, inArray } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  clusterMembers as clusterMembersTable,
  clusterWarnings as clusterWarningsTable,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { nowIso } from "../../ids";
import { requireInstanceAdmin } from "../../membership";
import {
  composeClusterWarnings,
  leaderWarnings,
  type ClusterWarning,
} from "../../clusters/warnings";
import { FAILOVER_MIN_MEMBERS, type Cluster } from "../../types/cluster";
import { messageOf } from "../../utils";
import { listClusterImageProgress } from "./images";
import { readClusterLeader } from "./leader";
import { listClusterWaiting } from "./placement";
import { getClusterById } from "./roster";

// A leader that hangs is a warning, not a stuck pass.
const READ_DEADLINE_MS = 15_000;

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]);
}

/** Asks the cluster's leader what is wrong and stores the answer; nothing to store while failover is off. */
export async function refreshClusterWarnings(cluster: Cluster): Promise<void> {
  const [{ n }] = await getDb()
    .select({ n: count() })
    .from(clusterMembersTable)
    .where(eq(clusterMembersTable.clusterId, cluster.id));
  const asks = cluster.failoverEnabled && n >= FAILOVER_MIN_MEMBERS;
  const found = asks
    ? leaderWarnings(
        await withDeadline(
          readClusterLeader(cluster).catch(() => null),
          READ_DEADLINE_MS,
        ),
      )
    : [];
  const at = nowIso();
  await getDb().transaction(async (tx) => {
    await tx
      .delete(clusterWarningsTable)
      .where(eq(clusterWarningsTable.clusterId, cluster.id));
    if (found.length > 0)
      await tx.insert(clusterWarningsTable).values(
        found.map((w, position) => ({
          clusterId: cluster.id,
          key: w.key,
          position,
          title: w.title,
          body: w.body,
          startLeader: w.startLeader ?? false,
          fixCloudflareToken: w.fixCloudflareToken ?? false,
          checkedAt: at,
        })),
      );
  });
}

/** One pass over every cluster, from the Deplo that watches them. */
export async function refreshAllClusterWarnings(): Promise<void> {
  const ids = (
    await getDb().select({ id: clustersTable.id }).from(clustersTable)
  ).map((r) => r.id);
  await Promise.all(
    ids.map(async (id) => {
      const cluster = await getClusterById(id);
      if (!cluster) return;
      await refreshClusterWarnings(cluster).catch((e) =>
        console.warn(`[cluster-warnings] ${id}: ${messageOf(e)}`),
      );
    }),
  );
}

/** A change the actor just made shows at once, not at the next pass. */
export function refreshClusterWarningsSoon(clusterId: string): void {
  void getClusterById(clusterId)
    .then((c) => (c ? refreshClusterWarnings(c) : undefined))
    .catch((e) =>
      console.warn(`[cluster-warnings] ${clusterId}: ${messageOf(e)}`),
    );
}

/** What the last background check found, per cluster. */
export async function storedClusterWarnings(
  clusterIds: string[],
): Promise<Map<string, ClusterWarning[]>> {
  await requireInstanceAdmin();
  const out = new Map<string, ClusterWarning[]>();
  if (clusterIds.length === 0) return out;
  const rows = await getDb()
    .select()
    .from(clusterWarningsTable)
    .where(inArray(clusterWarningsTable.clusterId, clusterIds))
    .orderBy(asc(clusterWarningsTable.position));
  for (const r of rows) {
    const list = out.get(r.clusterId) ?? [];
    list.push({
      key: r.key,
      title: r.title,
      body: r.body,
      ...(r.startLeader ? { startLeader: true } : {}),
      ...(r.fixCloudflareToken ? { fixCloudflareToken: true } : {}),
    });
    out.set(r.clusterId, list);
  }
  return out;
}

/** Every banner for a cluster: the stored leader check plus the active team's Apps, read from the database. */
export async function loadClusterWarnings(
  cluster: Cluster,
  servers: number,
  stored: ClusterWarning[],
): Promise<ClusterWarning[]> {
  const [waiting, copies] = await Promise.all([
    listClusterWaiting(cluster.id).catch(() => []),
    cluster.failoverEnabled
      ? listClusterImageProgress(cluster.id).catch(() => [])
      : [],
  ]);
  return composeClusterWarnings({
    failoverEnabled: cluster.failoverEnabled,
    servers,
    leader: stored,
    waiting,
    copies,
  });
}
