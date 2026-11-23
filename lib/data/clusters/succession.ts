import "server-only";

import { and, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { directCore, type PathReport } from "../../clusters/direct-core";
import {
  callClusterLeader,
  clusterLeaderAnswers,
  installClusterLeader,
  memberSucceeds,
  probeClusterHost,
} from "../../infra/agent-client/cluster-host";
import { instanceFrozen } from "../deplo-move/freeze";
import type { Cluster } from "../../types/cluster";
import { messageOf } from "../../utils";
import { getServerById } from "../servers/roster";
import { agentBehind } from "./binary-rollout";
import { clusterMemberFacts } from "./facts";
import { leaderHostOf } from "./host";
import { clusterNetworkLinksOf } from "./network";
import { clusterMemberServerIds, getClusterById } from "./roster";

// A cluster's leader lives on one of its own servers, with a line of members after it (ADR-0043, 23 Nov 2026).
// https://deplo.build/docs/operations/clusters/leader#the-line-of-succession

/** How many members a line names before Deplo's machine; the leader binary keeps the same (`LineLength`). */
export const LINE_LENGTH = 2;

const warn = (clusterId: string, e: unknown) =>
  console.warn(`[cluster-leader] ${clusterId}: ${messageOf(e)}`);

async function pathReports(
  clusterId: string,
  ids: string[],
): Promise<PathReport[]> {
  const links = await clusterNetworkLinksOf(clusterId, ids);
  return [...links].flatMap(([serverId, list]) =>
    list.map((l) => ({ serverId, peerServerId: l.peerServerId, path: l.path })),
  );
}

/**
 * The members a leader may run on: in the largest group that reaches each other directly, not being emptied, with an
 * agent that runs a leader. In join order; none while two or more members have not reported a direct pair yet.
 */
export async function leaderCandidates(clusterId: string): Promise<string[]> {
  const ids = await clusterMemberServerIds(clusterId);
  const core = directCore(ids, await pathReports(clusterId, ids));
  if (ids.length > 1 && core.length < 2) return [];
  const facts = new Map(
    (await clusterMemberFacts(clusterId)).map((f) => [f.id, f]),
  );
  const out: string[] = [];
  for (const id of core)
    if (!facts.get(id)?.emptying && (await probeClusterHost(id)) === "ok")
      out.push(id);
  return out;
}

/** Where a cluster's leader should live: the candidate with the most free memory, the fewest workloads on a tie. */
export async function leaderHome(clusterId: string): Promise<string | null> {
  const facts = new Map(
    (await clusterMemberFacts(clusterId)).map((f) => [f.id, f]),
  );
  const load = (id: string) => facts.get(id)!;
  const [home] = (await leaderCandidates(clusterId)).sort(
    (a, b) =>
      load(b).freeMb - load(a).freeMb || load(a).workloads - load(b).workloads,
  );
  return home ?? null;
}

/**
 * The members that lead after the leader, heir first, in join order: candidates beside the leader's own server.
 * None unless every member's agent pre-votes, since an older one would take an heir's epoch unasked.
 */
export async function clusterHeirs(cluster: Cluster): Promise<string[]> {
  const ids = await clusterMemberServerIds(cluster.id);
  for (const id of ids) if (!(await memberSucceeds(id))) return [];
  const leader = (await leaderHostOf(cluster.leaderServerId))?.id;
  return (await leaderCandidates(cluster.id))
    .filter((id) => id !== leader)
    .slice(0, LINE_LENGTH);
}

/** Whether every member's agent pre-votes, so Deplo's machine standing in asks before it leads. */
export async function clusterPreVotes(clusterId: string): Promise<boolean> {
  const ids = await clusterMemberServerIds(clusterId);
  for (const id of ids) if (!(await memberSucceeds(id))) return false;
  return ids.length > 0;
}

/**
 * The leader runs on Deplo's machine and Deplo's machine is not one of the cluster's servers: then nobody stands in
 * for it. A server an admin picked stays where it is.
 */
export async function leaderOutside(cluster: Cluster): Promise<boolean> {
  if (cluster.leaderServerId) return false;
  const own = await leaderHostOf(null);
  return !!own && !(await clusterMemberServerIds(cluster.id)).includes(own.id);
}

export interface LeadingHeir {
  serverId: string;
  epoch: number;
  head: number;
}

/** An heir that leads the cluster at a newer epoch than Deplo stored: it took over on its own. Never throws. */
export async function leadingHeir(
  cluster: Cluster,
): Promise<LeadingHeir | null> {
  for (const serverId of await clusterHeirs(cluster).catch(() => [])) {
    try {
      const raw = await callClusterLeader(
        serverId,
        "leader.snapshot",
        new TextEncoder().encode("{}"),
      );
      const snap = JSON.parse(new TextDecoder().decode(raw)) as {
        head?: number;
        clusters?: Record<
          string,
          { epoch: number; leads: boolean; since?: number }
        >;
      };
      const v = snap.clusters?.[cluster.id];
      // Its moves while Deplo was away are replayed from where its epoch began.
      if (v?.leads && v.epoch > cluster.leaderEpoch)
        return {
          serverId,
          epoch: v.epoch,
          head: v.since ? v.since - 1 : Number(snap.head) || 0,
        };
    } catch {
      // not answering: not the one that leads
    }
  }
  return null;
}

/** Stores an heir that leads as the cluster's leader, at the epoch it took: Deplo adopts it, it names no new one. */
export async function adoptHeir(
  cluster: Cluster,
  heir: LeadingHeir,
): Promise<boolean> {
  const done = await getDb()
    .update(clustersTable)
    .set({
      leaderServerId: heir.serverId,
      leaderTakeoverAt: null,
      leaderEpoch: heir.epoch,
      eventSeq: heir.head,
    })
    .where(
      and(
        eq(clustersTable.id, cluster.id),
        eq(clustersTable.leaderEpoch, cluster.leaderEpoch),
      ),
    )
    .returning({ id: clustersTable.id });
  return done.length > 0;
}

// The heirs each cluster had at the last pass: a change re-keys the bundles and re-pins the members.
const lastHeirs = new Map<string, string>();

/** Test seam. */
export function __forgetHeirsForTest(): void {
  lastHeirs.clear();
}

/**
 * One pass: every heir runs a leader of its own, and says whether a cluster's heirs changed since the last pass, so the
 * caller re-pins the members and re-seals the bundles. Never throws.
 */
export async function keepHeirsReady(cluster: Cluster): Promise<boolean> {
  const heirs = await clusterHeirs(cluster).catch(() => []);
  let ready = true;
  for (const id of heirs)
    if (!(await clusterLeaderAnswers(id))) {
      ready = false;
      // Every member reaches it directly, so it needs no relay of its own.
      await installClusterLeader(id, { relay: false }).catch((e) =>
        warn(cluster.id, e),
      );
    }
  const signature = heirs.join(",");
  const changed = lastHeirs.get(cluster.id) !== signature;
  // An heir whose leader only just started gives its key at the next pass: the line counts as new until then.
  if (ready) lastHeirs.set(cluster.id, signature);
  else lastHeirs.delete(cluster.id);
  return changed;
}

/** The clusters led from Deplo's machine from outside them, with the member that should lead instead. */
export async function leadersToMove(): Promise<
  { cluster: Cluster; to: string; toName: string }[]
> {
  if (await instanceFrozen()) return [];
  const rows = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable);
  const out: { cluster: Cluster; to: string; toName: string }[] = [];
  for (const { id } of rows) {
    const cluster = await getClusterById(id);
    // Deplo's machine standing in is the supervisor's to end, not a move.
    if (!cluster || cluster.leaderTakeoverAt || !(await leaderOutside(cluster)))
      continue;
    const to = await leaderHome(id).catch(() => null);
    const server = to ? await getServerById(to) : null;
    // Its agent first: the one beside a leader starts and stops it, and an update would restart it again at once.
    if (server && !(await agentBehind(server.id).catch(() => true)))
      out.push({ cluster, to: server.id, toName: server.name });
  }
  return out;
}
