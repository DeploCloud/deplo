import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { nowIso } from "../../ids";
import {
  clusterLeaderAnswers,
  installClusterLeader,
} from "../../infra/agent-client/cluster-host";
import type { Cluster } from "../../types/cluster";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import { getServerById } from "../servers/roster";
import { reconcileClusterBundles } from "./bundles";
import { leaderHostOf } from "./host";
import { leadFrom } from "./leader-move";
import { ensureClusterRelay, pushClusterRoster } from "./relay";
import { getClusterById } from "./roster";

// Deplo's own machine leads a cluster while its leader on another server does not answer (spec #176).
// https://deplo.build/docs/operations/clusters#run-the-leader-on-another-server

/** Checks in a row a leader may miss before Deplo's machine leads in its place: under the minute a member waits. */
export const TAKEOVER_AFTER_MISSES = 2;

const misses = new Map<string, number>();

/** Test seam: forget every missed check. */
export function __resetLeaderChecksForTest(): void {
  misses.clear();
}

export type LeaderHandover = "taken_over" | "handed_back" | null;

// The team of the admin who moved the leader reads what Deplo does about it.
async function say(cluster: Cluster, message: string): Promise<void> {
  const [row] = await getDb()
    .select({ teamId: clustersTable.leaderTeamId })
    .from(clustersTable)
    .where(eq(clustersTable.id, cluster.id))
    .limit(1);
  await recordActivity("server", message, "Deplo", null, row?.teamId ?? null);
}

/**
 * One check of a leader that runs on another server. Away twice in a row, Deplo's own machine leads from the next
 * epoch; once it answers again it leads again, from another epoch. Background work: nothing changes while frozen.
 */
export async function superviseClusterLeader(
  clusterId: string,
): Promise<LeaderHandover> {
  if (await instanceFrozen()) return null;
  const cluster = await getClusterById(clusterId);
  if (!cluster?.leaderServerId) {
    misses.delete(clusterId);
    return null;
  }
  const answers = await clusterLeaderAnswers(cluster.leaderServerId);
  const name =
    (await getServerById(cluster.leaderServerId))?.name ??
    "The leader's server";
  if (cluster.leaderTakeoverAt) {
    if (!answers) return null;
    await leadFrom(cluster, {
      leaderServerId: cluster.leaderServerId,
      leaderTakeoverAt: null,
    });
    await say(
      cluster,
      `${name} answers again, so it leads cluster ${cluster.name} again`,
    );
    // What was deployed while it was away reaches it now.
    await reconcileClusterBundles(clusterId).catch(() => {});
    return "handed_back";
  }
  if (answers) {
    misses.delete(clusterId);
    return null;
  }
  const missed = (misses.get(clusterId) ?? 0) + 1;
  misses.set(clusterId, missed);
  if (missed < TAKEOVER_AFTER_MISSES) return null;
  const own = await leaderHostOf(null);
  if (!own) return null;
  if (!(await clusterLeaderAnswers(own.id)))
    await installClusterLeader(own.id, { relay: true });
  await leadFrom(cluster, {
    leaderServerId: cluster.leaderServerId,
    leaderTakeoverAt: nowIso(),
  });
  misses.delete(clusterId);
  await say(
    cluster,
    `${name} stopped answering, so Deplo's machine leads cluster ${cluster.name} until it answers again`,
  );
  await reconcileClusterBundles(clusterId).catch(() => {});
  return "taken_over";
}

/**
 * After a Deplo move (ADR-0035) this machine's leader is a new one with a new key. It is started, leads what Deplo's
 * machine led from a newer epoch than the old machine's leader holds, and gets every bundle sealed for it.
 */
export async function leadClustersAfterMove(): Promise<void> {
  const rows = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable);
  if (rows.length === 0) return;
  // The relay comes up with it: this machine's proxy carries its door.
  await ensureClusterRelay();
  for (const { id } of rows) {
    const warn = (e: unknown) =>
      console.warn(
        `[cluster-leader] ${id}: ${e instanceof Error ? e.message : String(e)}`,
      );
    const cluster = (await getClusterById(id))!;
    if (!cluster.leaderServerId || cluster.leaderTakeoverAt)
      await leadFrom(cluster, {
        leaderServerId: cluster.leaderServerId,
        leaderTakeoverAt: cluster.leaderTakeoverAt,
      }).catch(warn);
    await pushClusterRoster(id).catch(warn);
    await reconcileClusterBundles(id).catch(warn);
  }
}
