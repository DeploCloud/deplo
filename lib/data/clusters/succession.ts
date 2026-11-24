import "server-only";

import { and, eq } from "drizzle-orm";
import { serverAnswers } from "../../infra/agent-link/registry";
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
import { clusterMembersReport } from "../servers/agent-capabilities";
import { CLUSTER_SUCCESSION_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
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
 * The members a leader may run on: among those whose agent runs a leader now, the largest group that reaches each
 * other directly, not being emptied. In join order; none while two or more have not reported a direct pair yet. A
 * server that stopped is left out first: its paths read as gone exactly when the line is needed (eu, 23 Nov 2026).
 */
export async function leaderCandidates(clusterId: string): Promise<string[]> {
  const ids = await clusterMemberServerIds(clusterId);
  const facts = new Map(
    (await clusterMemberFacts(clusterId)).map((f) => [f.id, f]),
  );
  // At once: a silent member waits out its link, and one per member in turn added up to a minute.
  const ok = await Promise.all(
    ids.map(async (id) => (await probeClusterHost(id)) === "ok"),
  );
  const live = ids.filter((_, i) => ok[i]);
  const core = directCore(live, await pathReports(clusterId, live));
  if (live.length > 1 && core.length < 2) return [];
  return core.filter((id) => !facts.get(id)?.emptying);
}

/**
 * The members whose agent does not answer now. What Deplo tells the others keeps them: one that was off at a push
 * keeps a list without them and leads later with what it held (eu, 23 Nov 2026). Never throws.
 */
export async function silentMembers(clusterId: string): Promise<string[]> {
  try {
    const ids = await clusterMemberServerIds(clusterId);
    const ok = await Promise.all(
      ids.map(async (id) => (await probeClusterHost(id)) === "ok"),
    );
    return ids.filter((_, i) => !ok[i]);
  } catch {
    return [];
  }
}

/**
 * Whether every member's agent pre-votes, as each last reported or says now: a member that is off still counts by
 * what it said. An older agent would take an heir's epoch unasked.
 */
async function everyMemberPreVotes(
  clusterId: string,
  ids: string[],
): Promise<boolean> {
  if (ids.length === 0) return false;
  if (
    await clusterMembersReport(clusterId, CLUSTER_SUCCESSION_CAPABILITY).catch(
      () => false,
    )
  )
    return true;
  for (const id of ids) if (!(await memberSucceeds(id))) return false;
  return true;
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
  if (!(await everyMemberPreVotes(cluster.id, ids))) return [];
  const leader = (await leaderHostOf(cluster.leaderServerId))?.id;
  return (await leaderCandidates(cluster.id))
    .filter((id) => id !== leader)
    .slice(0, LINE_LENGTH);
}

/** Whether every member's agent pre-votes, so Deplo's machine standing in asks before it leads. */
export async function clusterPreVotes(clusterId: string): Promise<boolean> {
  return everyMemberPreVotes(
    clusterId,
    await clusterMemberServerIds(clusterId),
  );
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
  /** When a quorum took its epoch, as its leader says; null from an older leader. */
  ledAt?: string | null;
}

interface HeirView {
  epoch: number;
  leads: boolean;
  succeed: boolean;
  head: number;
  ledAt: string | null;
}

// What the leader on an heir's server says of the cluster; undefined when it does not answer, null when it holds none.
async function heirView(
  serverId: string,
  clusterId: string,
): Promise<HeirView | null | undefined> {
  // A server silent on its link does not answer: asking would only wait out its Hello.
  if (serverAnswers(serverId) === false) return undefined;
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
        {
          epoch: number;
          leads: boolean;
          succeed?: boolean;
          since?: number;
          ledAt?: string;
        }
      >;
    };
    const v = snap.clusters?.[clusterId];
    if (!v) return null;
    // Its moves while Deplo was away are replayed from where its epoch began.
    return {
      epoch: v.epoch,
      leads: v.leads,
      succeed: v.succeed === true,
      head: v.since ? v.since - 1 : Number(snap.head) || 0,
      ledAt: typeof v.ledAt === "string" ? v.ledAt : null,
    };
  } catch {
    return undefined;
  }
}

/**
 * The heir that leads the cluster at a newer epoch than Deplo stored, the highest when two say they lead: it took over
 * on its own, and a quorum holds that epoch. Never throws.
 */
export async function leadingHeir(
  cluster: Cluster,
): Promise<LeadingHeir | null> {
  // While Deplo's machine stands in, an heir that leads at the epoch it took took it from the servers it never reached.
  const newer = (epoch: number) =>
    epoch > cluster.leaderEpoch ||
    (!!cluster.leaderTakeoverAt && epoch === cluster.leaderEpoch);
  let best: LeadingHeir | null = null;
  for (const [serverId, v] of await lineViews(cluster))
    if (v?.leads && newer(v.epoch) && (!best || v.epoch > best.epoch))
      best = { serverId, epoch: v.epoch, head: v.head, ledAt: v.ledAt };
  return best;
}

/**
 * Every member but the stored leader's, in join order, with what its leader says, while every agent pre-votes. Not the
 * candidates: the paths of the servers that stopped read as gone exactly when the line is needed. Never throws.
 */
async function lineViews(
  cluster: Cluster,
): Promise<[string, HeirView | null | undefined][]> {
  try {
    const ids = await clusterMemberServerIds(cluster.id);
    if (!(await everyMemberPreVotes(cluster.id, ids))) return [];
    const leader = (await leaderHostOf(cluster.leaderServerId))?.id;
    const line = ids.filter((id) => id !== leader);
    const views = await Promise.all(line.map((id) => heirView(id, cluster.id)));
    return line.map((id, i) => [id, views[i]]);
  } catch {
    return [];
  }
}

/**
 * The line as Deplo reaches it: whether any heir answers, and the first one that tries to lead at a newer epoch, the
 * one Deplo's word goes to when exactly half of the servers are left. Never throws.
 */
export async function lineReach(
  cluster: Cluster,
): Promise<{ answers: boolean; trying: LeadingHeir | null }> {
  let answers = false;
  for (const [serverId, v] of await lineViews(cluster)) {
    if (v === undefined) continue;
    answers = true;
    if (v && v.succeed && !v.leads && v.epoch > cluster.leaderEpoch)
      return { answers, trying: { serverId, epoch: v.epoch, head: v.head } };
  }
  return { answers, trying: null };
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
      resumeEventSeq: null,
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
export async function leadersToMove(): Promise<LeaderToMove[]> {
  if (await instanceFrozen()) return [];
  const rows = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable);
  const out: LeaderToMove[] = [];
  for (const { id } of rows) {
    const cluster = await getClusterById(id);
    // Deplo's machine standing in is the supervisor's to end, not a move.
    if (!cluster || cluster.leaderTakeoverAt) continue;
    const why = (await leaderOutside(cluster))
      ? "outside"
      : (await leaderRelayed(cluster))
        ? "relayed"
        : null;
    if (!why) continue;
    const to = await leaderHome(id).catch(() => null);
    const server = to ? await getServerById(to) : null;
    // Its agent first: the one beside a leader starts and stops it, and an update would restart it again at once.
    if (server && !(await agentBehind(server.id).catch(() => true)))
      out.push({ cluster, to: server.id, toName: server.name, why });
  }
  return out;
}

export interface LeaderToMove {
  cluster: Cluster;
  to: string;
  toName: string;
  /** On Deplo's machine from outside the cluster, or on a member that left the direct majority. */
  why: "outside" | "relayed";
}

/** The leader's member reaches some others only through the relay while two or more members reach each other directly. */
async function leaderRelayed(cluster: Cluster): Promise<boolean> {
  const id = cluster.leaderServerId;
  if (!id || !(await clusterMemberServerIds(cluster.id)).includes(id))
    return false;
  // A leader that does not answer is the supervisor's: an heir may lead already, and a move would hand over its head.
  if ((await probeClusterHost(id)) !== "ok") return false;
  const candidates = await leaderCandidates(cluster.id);
  return candidates.length >= 2 && !candidates.includes(id);
}
