import "server-only";

import { asc, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { clusterMembers as membersTable } from "../../db/schema/control-plane/clusters";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "../../deploy/domains";
import { requireActiveTeamId } from "../../membership";
import { archWords, type Cluster } from "../../types/cluster";
import { clusterMemberFacts, neededMb } from "./facts";
import { listClustersForTeam } from "./roster";

// Moving an App or database onto one server of its cluster by hand.
// https://deplo.build/docs/operations/clusters/manage-servers#move-to-one-server

/** What is being moved onto a member. Internal: callers hold the gates. */
export interface MemberMove {
  id: string;
  name: string;
  limitMb: number;
  replicas?: number;
  /** The architectures its image runs on; empty means any. */
  archs: string[];
  /** The member it runs on now, if it is on this cluster already. */
  on?: string | null;
}

export interface ClusterServerChoice {
  id: string;
  name: string;
  isDeploHost: boolean;
  /** Why it cannot take this one now, in the sentence a move would be refused with; null when it can. */
  refusal: string | null;
  /** It runs it now. */
  here: boolean;
}

export interface ClusterChoice {
  id: string;
  name: string;
  servers: ClusterServerChoice[];
}

async function members(clusterId: string) {
  return getDb()
    .select({
      id: membersTable.serverId,
      leaseState: membersTable.leaseState,
      removing: membersTable.emptyingSince,
      server: serversTable,
    })
    .from(membersTable)
    .innerJoin(serversTable, eq(serversTable.id, membersTable.serverId))
    .where(eq(membersTable.clusterId, clusterId))
    .orderBy(asc(membersTable.joinedAt), asc(membersTable.serverId));
}

async function refusals(
  cluster: Cluster,
  w: MemberMove,
): Promise<
  { row: Awaited<ReturnType<typeof members>>[number]; refusal: string | null }[]
> {
  const rows = await members(cluster.id);
  const free = new Map(
    (await clusterMemberFacts(cluster.id)).map((f) => [f.id, f.freeMb]),
  );
  const need = neededMb(w.id, w.limitMb);
  return rows.map((row) => {
    const name = row.server.name;
    const refusal =
      (w.replicas ?? 1) > 1
        ? `${w.name} runs ${w.replicas} replicas, and cluster ${cluster.name} spreads them over its servers.`
        : row.removing
          ? `${name} is being removed from cluster ${cluster.name}.`
          : row.leaseState !== "ok" || row.server.status === "offline"
            ? `${name} is offline, so ${w.name} cannot move there now.`
            : w.archs.length > 0 && !w.archs.includes(row.server.hostArch)
              ? `${w.name} runs on ${archWords(w.archs)} servers only, and ${name} is not one.`
              : w.on !== row.id && (free.get(row.id) ?? 0) < need
                ? `${name} has ${free.get(row.id) ?? 0} MB free and ${w.name} needs ${need} MB.`
                : null;
    return { row, refusal };
  });
}

/** Refuses, before anything stops, unless `serverId` of the cluster can take the workload now. */
export async function assertMemberTakes(
  cluster: Cluster,
  serverId: string,
  w: MemberMove,
): Promise<void> {
  const mine = (await refusals(cluster, w)).find((r) => r.row.id === serverId);
  if (!mine) throw new Error(`That server is not in cluster ${cluster.name}.`);
  if (mine.refusal) throw new Error(mine.refusal);
}

/** The Move picker's cluster groups: every cluster the active team may use, each server with what stops it. */
export async function listClusterServerChoices(
  w: Omit<MemberMove, "on"> & { clusterId?: string | null; serverId?: string },
): Promise<ClusterChoice[]> {
  const teamId = await requireActiveTeamId();
  const self = deploHostSelfAddresses();
  const out: ClusterChoice[] = [];
  for (const c of await listClustersForTeam(teamId)) {
    const on = c.id === w.clusterId ? (w.serverId ?? null) : null;
    const rows = await refusals(c, { ...w, on });
    out.push({
      id: c.id,
      name: c.name,
      servers: rows.map(({ row, refusal }) => ({
        id: row.id,
        name: row.server.name,
        isDeploHost: isDeploHostServer(row.server, self),
        refusal,
        here: row.id === on,
      })),
    });
  }
  return out;
}
