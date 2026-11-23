import "server-only";

import { eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { nowIso } from "../../ids";
import {
  clusterLeaderAnswers,
  clusterLeaderReach,
  installClusterLeader,
} from "../../infra/agent-client/cluster-host";
import type { Cluster } from "../../types/cluster";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import { getServerById } from "../servers/roster";
import { updatingClusterHost } from "./binary-rollout";
import { reconcileClusterBundles } from "./bundles";
import { leaderHostOf } from "./host";
import {
  __setLeaderBeatClockForTest,
  forgetHeir,
  leaderNamedRecently,
  nameHeir,
  namedHeir,
  tellLeaderReplaced,
} from "./leader-beat";
import {
  forgetLeaderRoster,
  pushLeaderRoster,
  readLeaderSnapshot,
} from "./leader-sync";
import {
  adoptHeir,
  clusterPreVotes,
  leadingHeir,
  lineReach,
  type LeadingHeir,
} from "./succession";
import { leadFrom, resumeSeqOf } from "./leader-move";
import { replayBeforeHandBack } from "./watch";
import { ensureClusterRelay, pushClusterRoster } from "./relay";
import { recordClusterActivity } from "./cluster-activity";
import { getClusterById } from "./roster";
import { messageOf } from "../../utils";

// Deplo's own machine leads a cluster while its leader on another server does not answer (spec #176).
// https://deplo.build/docs/operations/clusters/leader#run-the-leader-on-another-server

/** Checks in a row a leader may miss before Deplo's machine leads in its place: under the minute a member waits. */
export const TAKEOVER_AFTER_MISSES = 2;

const misses = new Map<string, number>();

/** Test seam: forget every missed check and every beat. */
export function __resetLeaderChecksForTest(): void {
  misses.clear();
  __setLeaderBeatClockForTest(null);
}

export type LeaderHandover = "taken_over" | "handed_back" | "succeeded" | null;

// The team of the admin who moved the leader reads what Deplo does about it.
async function say(cluster: Cluster, message: string): Promise<void> {
  const [row] = await getDb()
    .select({ teamId: clustersTable.leaderTeamId })
    .from(clustersTable)
    .where(eq(clustersTable.id, cluster.id))
    .limit(1);
  if (row?.teamId)
    await recordActivity("server", message, "Deplo", null, row.teamId);
  else await recordClusterActivity(cluster.id, message);
}

/**
 * One check of a leader that runs on another server. Away twice in a row and unnamed for 25 s, Deplo's own machine
 * leads from the next epoch; once it answers again it leads again, from another. Nothing changes while frozen.
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
  // Deplo is restarting it for an update: its leases are extended, and nobody needs to stand in.
  if (updatingClusterHost(cluster.leaderServerId)) return null;
  // The heir is asked while the leader is: a leader that went silent waits out its link first.
  const [reach, leading] = await Promise.all([
    clusterLeaderReach(cluster.leaderServerId),
    leadingHeir(cluster),
  ]);
  const answers = reach === "answers";
  const name =
    (await getServerById(cluster.leaderServerId))?.name ??
    "The leader's server";
  // A member next in line may lead on its own already: Deplo adopts it, rather than standing in or handing back.
  if (!answers || cluster.leaderTakeoverAt || !(await stillLeads(cluster))) {
    const heir = leading;
    if (heir && heir.serverId !== cluster.leaderServerId) {
      await adopt(cluster, heir, name);
      return "succeeded";
    }
  }
  if (cluster.leaderTakeoverAt) {
    if (!answers) return null;
    // What it did while Deplo's machine stood in is said first, at its own times, and the roster it gets back keeps it.
    const replayed = await replayBeforeHandBack(
      cluster,
      cluster.leaderServerId,
      await resumeSeqOf(cluster.id),
    );
    await leadFrom(cluster, {
      leaderServerId: cluster.leaderServerId,
      leaderTakeoverAt: null,
      eventSeq: replayed,
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
    // Heard again before the heir led: the heir's word runs out before the leader gets it back.
    if (namedHeir(clusterId)) forgetHeir(clusterId);
    return null;
  }
  const missed = (misses.get(clusterId) ?? 0) + 1;
  misses.set(clusterId, missed);
  if (missed < TAKEOVER_AFTER_MISSES) return null;
  const named = namedHeir(clusterId);
  // It may still lead its half of a split on Deplo's last word: two leaders never hold one half each.
  if (!named && leaderNamedRecently(clusterId)) return null;
  // Deplo's word goes to the next in line that tries to lead; its own machine stands in only when nobody in the line answers.
  const line = await lineReach(cluster);
  if (line.trying) {
    if (named && named.serverId !== line.trying.serverId) {
      forgetHeir(clusterId);
      return null;
    }
    nameHeir(clusterId, line.trying.serverId, line.trying.epoch);
    if (!named) {
      const heirName =
        (await getServerById(line.trying.serverId))?.name ?? "A server";
      await say(
        cluster,
        `${name} stopped answering, so Deplo gives its word to ${heirName}, next in line, to lead cluster ${cluster.name}`,
      );
    }
    return null;
  }
  if (named && !line.answers) forgetHeir(clusterId);
  if (line.answers || namedHeir(clusterId)) return null;
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
    reach === "outdated"
      ? `The leader on ${name} is older than this Deplo accepts, so Deplo's machine leads cluster ${cluster.name} until it is updated`
      : (await clusterPreVotes(cluster.id).catch(() => false))
        ? `${name} stopped answering Deplo, so Deplo's machine leads cluster ${cluster.name} once its servers stop hearing ${name} too, until it answers again`
        : `${name} stopped answering, so Deplo's machine leads cluster ${cluster.name} until it answers again`,
  );
  await reconcileClusterBundles(clusterId).catch(() => {});
  return "taken_over";
}

// Whether the leader Deplo stored leads by its own word; one that does not answer the question is taken to.
async function stillLeads(cluster: Cluster): Promise<boolean> {
  try {
    const snap = await readLeaderSnapshot(cluster);
    const v = snap?.clusters[cluster.id];
    return !v || (!v.superseded && v.epoch >= cluster.leaderEpoch);
  } catch {
    return true;
  }
}

async function adopt(
  cluster: Cluster,
  heir: LeadingHeir,
  name: string,
): Promise<void> {
  if (!(await adoptHeir(cluster, heir))) return;
  misses.delete(cluster.id);
  const named = namedHeir(cluster.id);
  if (named) forgetHeir(cluster.id, named.serverId === heir.serverId);
  // Said when it is adopted: what follows reaches every member, and a silent one waits out its link.
  const heirName = (await getServerById(heir.serverId))?.name ?? "A server";
  await say(
    cluster,
    `${name} stopped answering its servers, so ${heirName}, next in line, leads cluster ${cluster.name}`,
  );
  forgetLeaderRoster(cluster.id);
  const led = (await getClusterById(cluster.id))!;
  await pushLeaderRoster(led).catch(() => false);
  await pushClusterRoster(cluster.id).catch(() => null);
  // The leader it replaced, and Deplo's machine if it stood in, stop at once when they hear the newer epoch.
  const own = await leaderHostOf(null);
  for (const id of new Set([cluster.leaderServerId, own?.id]))
    if (id && id !== heir.serverId)
      await tellLeaderReplaced(id, cluster.id, heir.epoch).catch(() => {});
  await reconcileClusterBundles(cluster.id).catch(() => {});
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
      console.warn(`[cluster-leader] ${id}: ${messageOf(e)}`);
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
