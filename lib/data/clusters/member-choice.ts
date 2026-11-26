import "server-only";

import { asc, eq } from "drizzle-orm";
import { getDb } from "../../db/client";
import { clusterMembers as membersTable } from "../../db/schema/control-plane/clusters";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { isDeploHostServer } from "../../deploy/domains";
import { connectAgent } from "../../infra/agent-client/connect";
import { requireActiveTeamId } from "../../membership";
import { archWords, type Cluster } from "../../types/cluster";
import { formatBytes } from "../backups/format-bytes";
import { markServerSeen } from "../servers/agent-handshake";
import { appDataBytes } from "./data-size";
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
  const facts = new Map(
    (await clusterMemberFacts(cluster.id)).map((f) => [f.id, f]),
  );
  const free = new Map([...facts].map(([id, f]) => [id, f.freeMb]));
  const need = neededMb(w.id, w.limitMb);
  const data = await appDataBytes(w.id);
  // Its data never leaves a member under a tenth of its disk free; one that holds it whole needs no more (ADR-0043).
  const noDisk = (id: string, name: string): string | null => {
    const f = facts.get(id);
    if (!f?.diskTotal || w.on === id) return null;
    const more = f.holds.includes(w.id) ? 0 : data;
    if (f.diskFree - more >= f.diskTotal / 10) return null;
    return more
      ? `${name} has ${formatBytes(f.diskFree)} free, too little for ${w.name}'s data (about ${formatBytes(more)}) and a tenth of its disk free.`
      : `${name} has less than a tenth of its disk free.`;
  };
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
              : w.on !== row.id && row.server.memoryMb <= 0
                ? waitingFor(name, w.name)
                : w.on !== row.id && (free.get(row.id) ?? 0) < need
                  ? `${name} has ${free.get(row.id) ?? 0} MB free and ${w.name} needs ${need} MB.`
                  : noDisk(row.id, name);
    return { row, refusal };
  });
}

// A member that just joined has sent no metrics yet: its memory is unknown, never none (c46: "eu-4 has 0 MB free").
const waitingFor = (name: string, what: string) =>
  `Waiting for ${name}'s first metrics, to know whether ${what} fits there.`;

/** Vars so tests hurry them: a move onto a member without metrics yet waits this long for them. */
export const factsWait = { everyMs: 1_000, maxMs: 60_000 };

const MIB = 1024 * 1024;

// c47: a new member's first metrics reached the panel 27 s after its agent started; the move asks the member itself.
async function askMetrics(serverId: string): Promise<void> {
  try {
    const conn = await connectAgent(serverId);
    try {
      const m = await conn.metrics("");
      if (m.cpuCores > 0)
        await markServerSeen(serverId, undefined, undefined, {
          cpuCores: m.cpuCores,
          memoryMb: Math.round(Number(m.memTotal) / MIB),
          diskGb: Math.round(Number(m.diskTotal) / (1024 * MIB)),
        });
    } finally {
      conn.close();
    }
  } catch {
    // Not answering yet: the next look asks again.
  }
}

/** Refuses, before anything stops, unless `serverId` of the cluster can take the workload now. */
export async function assertMemberTakes(
  cluster: Cluster,
  serverId: string,
  w: MemberMove,
): Promise<void> {
  const until = Date.now() + factsWait.maxMs;
  for (;;) {
    const mine = (await refusals(cluster, w)).find(
      (r) => r.row.id === serverId,
    );
    if (!mine)
      throw new Error(`That server is not in cluster ${cluster.name}.`);
    if (!mine.refusal) return;
    const name = mine.row.server.name;
    if (mine.refusal !== waitingFor(name, w.name))
      throw new Error(mine.refusal);
    if (Date.now() >= until)
      throw new Error(
        `No metrics came from ${name} within ${Math.round(factsWait.maxMs / 1000)} s, so Deplo does not know its memory yet and cannot tell whether ${w.name} fits there.`,
      );
    await askMetrics(serverId);
    await new Promise((r) => setTimeout(r, factsWait.everyMs));
  }
}

/** The Move picker's cluster groups: every cluster the active team may use, each server with what stops it. */
export async function listClusterServerChoices(
  w: Omit<MemberMove, "on"> & { clusterId?: string | null; serverId?: string },
): Promise<ClusterChoice[]> {
  const teamId = await requireActiveTeamId();
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
        isDeploHost: isDeploHostServer(row.server),
        refusal,
        here: row.id === on,
      })),
    });
  }
  return out;
}
