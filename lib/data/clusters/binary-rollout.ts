import "server-only";

import { and, eq, gt, inArray, ne } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  clusterBinaryUpdates,
  clusterMembers,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import {
  clusterLeaderStatus,
  clusterPin,
  installClusterLeader,
} from "../../infra/agent-client/cluster-host";
import { connectAgent } from "../../infra/agent-client/connect";
import type { ClusterHostStatus } from "../../infra/agent-client/connection";
import type { Server } from "../../types/server";
import { AGENT_VERSION, clusterPinned, isNewer } from "../../version";
import { recordActivity } from "../activity";
import { instanceFrozen } from "../deplo-move/freeze";
import { nextRetryAt } from "../servers/agent-update-state";
import { getServerById } from "../servers/roster";
import { leaderHostOf } from "./host";
import { forgetLeaderRoster } from "./leader-sync";
import { messageOf } from "../../utils";

// Deplo keeps every leader and relay on the cluster release it pins, forward only, one server at a time.
// See docs/agents/cluster-rollout.md.

export type ClusterUpdateFailure = "busy" | "error" | "no_return";
type UpdateRow = typeof clusterBinaryUpdates.$inferSelect;

export const clusterRolloutTiming = { confirmTries: 10, confirmDelayMs: 1500 };

// ponytail: a fixed bound on how long a silent member's work may still be moving (the leader's longest start is
// 35 minutes); read the leader's own in-flight moves if a restart ever has to wait less.
const MOVING_MS = 45 * 60_000;

const updating = new Set<string>();

/** Whether this Deplo is restarting the leader on the server right now: its silence is not an outage. */
export function updatingClusterHost(serverId: string): boolean {
  return updating.has(serverId);
}

function sentence(e: unknown): string {
  const text = messageOf(e).trim();
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** The update that is failing on the server against the release this Deplo pins now; null when none is. */
export async function failingClusterUpdate(
  serverId: string,
): Promise<UpdateRow | null> {
  const [row] = await getDb()
    .select()
    .from(clusterBinaryUpdates)
    .where(
      and(
        eq(clusterBinaryUpdates.serverId, serverId),
        eq(clusterBinaryUpdates.targetVersion, clusterPin().version),
      ),
    );
  return row ?? null;
}

async function clearUpdate(serverId: string): Promise<void> {
  await getDb()
    .delete(clusterBinaryUpdates)
    .where(eq(clusterBinaryUpdates.serverId, serverId));
}

type Host = {
  server: Server;
  /** The clusters whose members it renews right now. */
  leads: { id: string; name: string }[];
  /** Whose Activity reads what Deplo does to it; null is the instance's own. */
  teamId: string | null;
};

/** Every server that runs the cluster binary, another server's before Deplo's own machine. */
async function clusterHosts(): Promise<Host[]> {
  const rows = await getDb()
    .select()
    .from(clustersTable)
    .orderBy(clustersTable.createdAt, clustersTable.id);
  if (rows.length === 0) return [];
  const hosts: Host[] = [];
  const own = await leaderHostOf(null);
  const remotes = [...new Set(rows.flatMap((c) => c.leaderServerId ?? []))];
  for (const id of remotes.sort()) {
    const server = await getServerById(id);
    const mine = rows.filter((c) => c.leaderServerId === id);
    if (server && server.id !== own?.id)
      hosts.push({
        server,
        leads: mine.filter((c) => !c.leaderTakeoverAt),
        teamId: mine.find((c) => c.leaderTeamId)?.leaderTeamId ?? null,
      });
  }
  // Last: it stands in for every other leader, and it is the machine that would say what went wrong.
  if (own)
    hosts.push({
      server: own,
      leads: rows.filter((c) => !c.leaderServerId || c.leaderTakeoverAt),
      teamId: rows.find((c) => c.leaderTeamId)?.leaderTeamId ?? null,
    });
  return hosts;
}

/** The cluster, among those the leader leads, with a server that stopped answering and whose work may still be moving. */
async function movingCluster(host: Host): Promise<string | null> {
  if (host.leads.length === 0) return null;
  const [row] = await getDb()
    .select({ clusterId: clusterMembers.clusterId })
    .from(clusterMembers)
    .where(
      and(
        inArray(
          clusterMembers.clusterId,
          host.leads.map((c) => c.id),
        ),
        ne(clusterMembers.leaseState, "ok"),
        gt(
          clusterMembers.leaseChangedAt,
          new Date(Date.now() - MOVING_MS).toISOString(),
        ),
      ),
    )
    .limit(1);
  return row ? host.leads.find((c) => c.id === row.clusterId)!.name : null;
}

// The agent installs, stops and starts the binary, so a server behind its own agent pin gets that update first.
async function agentBehind(serverId: string): Promise<boolean> {
  const conn = await connectAgent(serverId);
  try {
    return isNewer(AGENT_VERSION, (await conn.hello()).agentVersion);
  } finally {
    conn.close();
  }
}

const what = (here: ClusterHostStatus) =>
  here.relay ? "cluster leader and relay" : "cluster leader";

async function fail(
  host: Host,
  here: ClusterHostStatus,
  row: UpdateRow | null,
  failure: ClusterUpdateFailure,
  error: string,
): Promise<void> {
  const { version } = clusterPin();
  const now = new Date();
  const attempts = (row?.attempts ?? 0) + 1;
  const next = {
    targetVersion: version,
    failure,
    attempts,
    firstFailedAt: row?.firstFailedAt ?? now.toISOString(),
    nextRetryAt: nextRetryAt(attempts, now),
    lastError: error.slice(0, 500),
    updatedAt: now.toISOString(),
  };
  await getDb()
    .insert(clusterBinaryUpdates)
    .values({ serverId: host.server.id, ...next })
    .onConflictDoUpdate({ target: clusterBinaryUpdates.serverId, set: next });
  if (!row)
    await recordActivity(
      "server",
      `Could not update the ${what(here)} on ${host.server.name} to v${version}: ${error} Deplo retries on its own.`,
      "Deplo",
      null,
      host.teamId,
    );
}

async function confirm(serverId: string): Promise<ClusterHostStatus | null> {
  const { version } = clusterPin();
  for (let i = 0; i < clusterRolloutTiming.confirmTries; i++) {
    if (i > 0)
      await new Promise((r) =>
        setTimeout(r, clusterRolloutTiming.confirmDelayMs),
      );
    const now = await clusterLeaderStatus(serverId).catch(() => null);
    if (now?.running && now.version === version) return now;
  }
  return null;
}

/** One server: updated when it is behind the pin and its retry is due. Answers false when the rest must wait for it. */
async function updateHost(host: Host): Promise<boolean> {
  const { version } = clusterPin();
  const id = host.server.id;
  // A server that does not answer is not known to be behind: the card already says it is not reachable.
  const here = await clusterLeaderStatus(id).catch(() => null);
  if (!here) return true;
  // Forward only: one on the pin or ahead of it is left alone.
  if (!here.installed || !isNewer(version, here.version)) {
    await clearUpdate(id);
    return true;
  }
  const row = await failingClusterUpdate(id);
  if (row && Date.parse(row.nextRetryAt) > Date.now())
    return row.failure !== "no_return";
  // Not a failure of this update: the agent rollout carries the server and says where it stands.
  if (await agentBehind(id).catch(() => true)) return true;
  const moving = await movingCluster(host);
  if (moving) {
    await fail(
      host,
      here,
      row,
      "busy",
      `A server of cluster ${moving} is not answering, and a leader is not restarted while its Apps may be moving.`,
    );
    return true;
  }
  updating.add(id);
  try {
    // The leader extends every lease before it stops, so no server of its clusters stops anything meanwhile.
    await installClusterLeader(id, { relay: here.relay });
    const now = await confirm(id);
    if (!now) {
      await fail(
        host,
        here,
        row,
        "no_return",
        "It took the new version but did not start on it. The other servers wait until it does.",
      );
      return false;
    }
  } catch (e) {
    await fail(host, here, row, "error", sentence(e));
    return true;
  } finally {
    updating.delete(id);
  }
  await clearUpdate(id);
  // A restarted leader is told again who is in its clusters.
  for (const c of host.leads) forgetLeaderRoster(c.id);
  await recordActivity(
    "server",
    `Updated the ${what(here)} on ${host.server.name} to v${version}`,
    "Deplo",
    null,
    host.teamId,
  );
  return true;
}

let pass: Promise<void> | null = null;

/** One pass over every server that runs the cluster binary; a pass already running is joined, not doubled. */
export function runClusterRollout(): Promise<void> {
  pass ??= rolloutPass().finally(() => {
    pass = null;
  });
  return pass;
}

async function rolloutPass(): Promise<void> {
  const { version } = clusterPin();
  if (!clusterPinned(version) || (await instanceFrozen())) return;
  const hosts = await clusterHosts();
  if (hosts.length === 0) return;
  // GitHub down: nothing is tried, so no server's wait grows on an outage.
  const { resolveClusterRelease } = await import("../../agent/release");
  if (!(await resolveClusterRelease(version))) return;
  for (const host of hosts) if (!(await updateHost(host))) return;
}
