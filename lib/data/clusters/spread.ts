import "server-only";

import { SPREAD_CAPABILITY } from "../../infra/agent-client/hello-capabilities";
import { serverSupports } from "../../infra/agent-client/preflight";
import type { App } from "../../types/app";
import { usesComposeStack } from "../../utils";
import { appHasTunnel } from "./app-tunnel";
import { syncNameForwardersSoon } from "./forwarders";
import {
  askLeaderToSpread,
  listWorkloadPlacements,
  PlacementRefusedError,
  PlacementUnavailableError,
  recordPlacement,
} from "./placement";
import { clusterMemberFacts } from "./facts";
import { getClusterById } from "./roster";

// Replicas across the members of a cluster (spec #176): an App with a Cloudflare domain spreads them, because
// its tunnel reaches every member; any other keeps them on one, where its address points.
// https://deplo.build/docs/operations/clusters#replicas-across-servers
// ponytail: a server that comes back with a replica still its own runs the release it had; the next deploy
// brings it level. Deploy that server alone on `member_returned` if a mixed release ever shows up.

export type ReplicaSpread =
  | { kind: "single" }
  | { kind: "spread"; servers: number }
  | { kind: "together"; why: "no_cloudflare" | "agent" };

export const SPREAD_NO_CLOUDFLARE =
  "Its replicas stay on one server: without a Cloudflare domain, visitors reach only that one.";
export const SPREAD_AGENT =
  "Its replicas stay on one server until every server agent in the cluster is up to date. Deplo updates them on its own.";

export function spreadSentence(servers: number): string {
  return `Spread across ${servers} servers: if one stops, the others keep answering`;
}

async function placed(appId: string): Promise<(string | null)[]> {
  const rows = (await listWorkloadPlacements("app", [appId])).get(appId) ?? [];
  return rows.map((r) => r.serverId);
}

const distinct = (members: (string | null)[]) => [
  ...new Set(members.filter((m): m is string => Boolean(m))),
];

/** Whether an App's replicas spread over its cluster's members, and why not when they stay together. */
export async function replicaSpread(app: App): Promise<ReplicaSpread> {
  if (!app.clusterId || app.replicas < 2 || usesComposeStack(app))
    return { kind: "single" };
  const members = await clusterMemberFacts(app.clusterId);
  if (members.length < 2) return { kind: "single" };
  if (!(await appHasTunnel(app.id)))
    return { kind: "together", why: "no_cloudflare" };
  const able = await Promise.all(
    members.map((m) => serverSupports(m.id, SPREAD_CAPABILITY)),
  );
  if (able.includes(false)) return { kind: "together", why: "agent" };
  const on = distinct(await placed(app.id)).length;
  return {
    kind: "spread",
    servers: on > 1 ? on : Math.min(app.replicas, members.length),
  };
}

/** The sentence the Replicas setting shows about a cluster App, or null when there is nothing to say. */
export async function replicaSpreadNote(app: App): Promise<string | null> {
  const s = await replicaSpread(app);
  if (s.kind === "spread") return spreadSentence(s.servers);
  if (s.kind === "together")
    return s.why === "agent" ? SPREAD_AGENT : SPREAD_NO_CLOUDFLARE;
  return null;
}

export interface ReplicaPlan {
  /** The members that run replicas, in placement order, and how many each. */
  members: { serverId: string; replicas: number }[];
  /** Members that ran some and run none now: their copy of the stack goes. */
  dropped: string[];
  /** Each member's stack is rendered for its own count, with the connector beside it. */
  spread: boolean;
}

/**
 * Settles where each replica of a cluster App runs before a deploy and records one row per replica. The leader
 * places them; a replica it keeps waiting for room stays its own. Null for an App this does not apply to.
 */
export async function planAppReplicas(app: App): Promise<ReplicaPlan | null> {
  if (!app.clusterId || usesComposeStack(app)) return null;
  const cluster = await getClusterById(app.clusterId);
  if (!cluster) return null;
  const current = await placed(app.id);
  // Nothing of it runs anywhere: the leader is still looking for room, and the deploy goes where it always did.
  if (current.length > 0 && distinct(current).length === 0) return null;
  const state = await replicaSpread(app);
  const facts = await clusterMemberFacts(cluster.id);
  let next: (string | null)[];
  if (state.kind === "spread") {
    const emptying = new Set(facts.filter((f) => f.emptying).map((f) => f.id));
    const settled =
      current.length === app.replicas &&
      distinct(current).length >= Math.min(app.replicas, facts.length) &&
      !current.some((m) => m && emptying.has(m));
    next = current;
    if (!settled)
      try {
        const arch = facts.find((f) => f.id === app.serverId)?.arch;
        next = await askLeaderToSpread(
          cluster,
          {
            kind: "app",
            id: app.id,
            name: app.name,
            environmentId: app.environmentId ?? null,
            limitMb: app.resources?.memoryMb ?? 0,
            // An image built here runs only on servers with this one's kind of processor.
            archs: app.source !== "docker-image" && arch ? [arch] : [],
          },
          app.replicas,
          current,
        );
      } catch (e) {
        const known =
          e instanceof PlacementRefusedError ||
          e instanceof PlacementUnavailableError;
        // What already runs keeps running where it is; only a change in how many needs the leader's word.
        if (!known || current.length !== app.replicas) throw e;
      }
  } else {
    const first = distinct(current)[0] ?? app.serverId;
    next = Array.from({ length: app.replicas }, () => first);
  }
  if (next.join() !== current.join()) {
    await recordPlacement({
      clusterId: cluster.id,
      kind: "app",
      workloadId: app.id,
      members: next,
      epoch: cluster.leaderEpoch,
    });
    syncNameForwardersSoon(cluster.id);
  }
  const members = distinct(next).map((serverId) => ({
    serverId,
    replicas: next.filter((m) => m === serverId).length,
  }));
  return {
    members,
    dropped: distinct(current).filter(
      (m) => !members.some((n) => n.serverId === m),
    ),
    spread: state.kind === "spread",
  };
}
