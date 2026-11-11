import "server-only";

import { asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterMembers as membersTable,
  clusterTeams as clusterTeamsTable,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { getCurrentUser } from "../../auth/current-user";
import { nowIso } from "../../ids";
import {
  isInstanceAdmin,
  requireActiveTeamId,
  requireInstanceAdmin,
} from "../../membership";
import { probeClusterMember } from "../../infra/agent-client/cluster-host";
import {
  failoverOn,
  type Cluster,
  type ClusterJoin,
  type ClusterJoinCandidate,
  type ClusterJoinReason,
  type ClusterLeaseState,
  type ClusterMember,
} from "../../types/cluster";
import type { ServerStatus } from "../../types/server";
import { recordActivity } from "../activity";
import { getServerById, listAllServers } from "../servers/roster";
import { recordJoinedPlacements } from "./placement";
import { pushClusterRoster } from "./relay";
import { getCluster, getClusterById } from "./roster";

/** A join refused: `reasons` lists every blocker found, so the admin fixes them in one pass. */
export class ClusterJoinRefusedError extends Error {
  constructor(readonly reasons: ClusterJoinReason[]) {
    super(reasons.map((r) => r.message).join(" "));
  }
}

function nameList(names: string[], max = 4): string {
  const shown = names.slice(0, max).join(", ");
  const rest = names.length - max;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/** The cluster a server is a member of, if any. */
export async function clusterOfServer(
  serverId: string,
): Promise<{ id: string; name: string } | null> {
  const rows = await getDb()
    .select({ id: clustersTable.id, name: clustersTable.name })
    .from(membersTable)
    .innerJoin(clustersTable, eq(clustersTable.id, membersTable.clusterId))
    .where(eq(membersTable.serverId, serverId))
    .limit(1);
  return rows[0] ?? null;
}

/** Refuses a server a cluster has taken: nobody places work on a member directly, the cluster does. */
export async function assertServerNotInCluster(
  serverId: string,
): Promise<void> {
  const cluster = await clusterOfServer(serverId);
  if (cluster)
    throw new Error(
      `That server is a member of cluster ${cluster.name}, so nothing can be placed on it directly.`,
    );
}

/** The ids of the servers that are members of any cluster: pickers leave them out. */
export async function clusterMemberServerIdSet(): Promise<Set<string>> {
  const rows = await getDb()
    .select({ id: membersTable.serverId })
    .from(membersTable);
  return new Set(rows.map((r) => r.id));
}

type Exec = Pick<ReturnType<typeof getDb>, "select">;

async function workloadTeamIds(serverId: string, db: Exec): Promise<string[]> {
  const [a, d] = await Promise.all([
    db
      .select({ teamId: appsTable.teamId })
      .from(appsTable)
      .where(eq(appsTable.serverId, serverId)),
    db
      .select({ teamId: databasesTable.teamId })
      .from(databasesTable)
      .where(eq(databasesTable.serverId, serverId)),
  ]);
  return [...new Set([...a, ...d].map((r) => r.teamId))];
}

async function otherTeamsReason(
  cluster: Cluster,
  serverName: string,
  serverId: string,
  db: Exec = getDb(),
): Promise<ClusterJoinReason | null> {
  if (cluster.allTeams) return null;
  const grants = await db
    .select({ teamId: clusterTeamsTable.teamId })
    .from(clusterTeamsTable)
    .where(eq(clusterTeamsTable.clusterId, cluster.id));
  const granted = new Set(grants.map((g) => g.teamId));
  const outside = (await workloadTeamIds(serverId, db)).filter(
    (t) => !granted.has(t),
  );
  if (outside.length === 0) return null;
  const names = await db
    .select({ name: teamsTable.name })
    .from(teamsTable)
    .where(inArray(teamsTable.id, outside))
    .orderBy(asc(teamsTable.name));
  return {
    code: "other_teams",
    message: `${serverName} runs work of ${nameList(names.map((n) => n.name))}, which ${cluster.name} is not shared with. Share the cluster with them first.`,
  };
}

/** Everything that stops `serverId` joining, without dialing it: what a picker can show before the admin chooses. */
async function staticReasons(
  cluster: Cluster,
  server: NonNullable<Awaited<ReturnType<typeof getServerById>>>,
): Promise<ClusterJoinReason[]> {
  const out: ClusterJoinReason[] = [];
  const held = await clusterOfServer(server.id);
  if (held)
    out.push({
      code: "in_cluster",
      message:
        held.id === cluster.id
          ? `${server.name} is already in ${cluster.name}.`
          : `${server.name} is already in cluster ${held.name}. A server is in at most one cluster.`,
    });
  if (server.importOnly)
    out.push({
      code: "cannot_host",
      message: `${server.name} is a migration source, not a server that runs work.`,
    });
  else if (server.storageOnly)
    out.push({
      code: "cannot_host",
      message: `${server.name} only keeps backups, so it can't run Apps.`,
    });
  else if (server.buildOnly)
    out.push({
      code: "cannot_host",
      message: `${server.name} only builds images, so it can't run Apps.`,
    });
  if (server.status === "offline")
    out.push({
      code: "offline",
      message: `${server.name} is offline. Bring it back online first.`,
    });
  const teams = await otherTeamsReason(cluster, server.name, server.id);
  if (teams) out.push(teams);
  return out;
}

/** The servers the join picker offers, each with what blocks it. Not dialed, so the join itself checks the agent again. */
export async function listClusterJoinCandidates(
  clusterId: string,
): Promise<ClusterJoinCandidate[]> {
  await requireInstanceAdmin();
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const servers = (await listAllServers()).filter((s) => !s.importOnly);
  const out: ClusterJoinCandidate[] = [];
  for (const s of servers)
    out.push({
      serverId: s.id,
      serverName: s.name,
      reasons: await staticReasons(cluster, s),
    });
  return out;
}

async function joinReasons(
  cluster: Cluster,
  server: NonNullable<Awaited<ReturnType<typeof getServerById>>>,
): Promise<ClusterJoinReason[]> {
  const out = await staticReasons(cluster, server);
  if (out.some((r) => r.code === "offline" || r.code === "cannot_host"))
    return out;
  const probe = await probeClusterMember(server.id);
  if (probe === "offline")
    out.push({
      code: "offline",
      message: `${server.name} is offline. Bring it back online first.`,
    });
  else if (probe === "too_old")
    out.push({
      code: "agent_too_old",
      message: `The Deplo agent on ${server.name} is too old to join a cluster. Update it first.`,
    });
  return out;
}

function toMember(r: {
  serverId: string;
  serverName: string;
  status: string;
  joinedAt: string;
  emptyingSince: string | null;
  leaseState: string;
}): ClusterMember {
  return {
    serverId: r.serverId,
    serverName: r.serverName,
    status: r.status as ServerStatus,
    joinedAt: r.joinedAt,
    emptyingSince: r.emptyingSince,
    leaseState: toLeaseState(r.leaseState),
  };
}

function toLeaseState(s: string): ClusterLeaseState {
  return s === "not_responding" || s === "fenced" ? s : "ok";
}

async function readMembers(clusterId: string): Promise<ClusterMember[]> {
  const rows = await getDb()
    .select({
      serverId: membersTable.serverId,
      serverName: serversTable.name,
      status: serversTable.status,
      joinedAt: membersTable.joinedAt,
      emptyingSince: membersTable.emptyingSince,
      leaseState: membersTable.leaseState,
    })
    .from(membersTable)
    .innerJoin(serversTable, eq(serversTable.id, membersTable.serverId))
    .where(eq(membersTable.clusterId, clusterId))
    .orderBy(asc(membersTable.joinedAt), asc(membersTable.serverId));
  return rows.map(toMember);
}

/** A cluster's members, for whoever may see the cluster: an instance admin, or a team it is shared with. */
export async function listClusterMembers(
  clusterId: string,
): Promise<ClusterMember[]> {
  const visible = (await isInstanceAdmin())
    ? await getClusterById(clusterId)
    : await getCluster(clusterId);
  return visible ? readMembers(clusterId) : [];
}

/**
 * Adds an existing server to a cluster. Its Apps and databases come along where they run: nothing restarts,
 * no address changes, `server_id` stays. Refused with every reason listed when it cannot join.
 */
export async function addClusterMember(
  clusterId: string,
  serverId: string,
): Promise<ClusterJoin> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const cluster = await getClusterById(clusterId);
  if (!cluster) throw new Error("Cluster not found");
  const server = await getServerById(serverId);
  if (!server) throw new Error("Server not found");

  const reasons = await joinReasons(cluster, server);
  if (reasons.length > 0) throw new ClusterJoinRefusedError(reasons);

  const came = await getDb().transaction(async (tx) => {
    const locked = await tx
      .select({ id: clustersTable.id })
      .from(clustersTable)
      .where(eq(clustersTable.id, clusterId))
      .for("update");
    if (!locked[0]) throw new Error("Cluster not found");
    const inserted = await tx
      .insert(membersTable)
      .values({ serverId, clusterId, joinedAt: nowIso() })
      .onConflictDoNothing()
      .returning({ serverId: membersTable.serverId });
    if (inserted.length === 0)
      throw new ClusterJoinRefusedError([
        {
          code: "in_cluster",
          message: `${server.name} is already in a cluster. A server is in at most one cluster.`,
        },
      ]);
    // The check above can be stale by now: a team's work may have landed on the server since.
    const late = await otherTeamsReason(cluster, server.name, serverId, tx);
    if (late) throw new ClusterJoinRefusedError([late]);
    const apps = await tx
      .update(appsTable)
      .set({ clusterId })
      .where(eq(appsTable.serverId, serverId))
      .returning({ id: appsTable.id, replicas: appsTable.replicas });
    const dbs = await tx
      .update(databasesTable)
      .set({ clusterId })
      .where(eq(databasesTable.serverId, serverId))
      .returning({ id: databasesTable.id });
    // Without these the leader never hears of the workloads, so it neither fences nor moves them.
    await recordJoinedPlacements(
      tx,
      serverId,
      Math.max(cluster.leaderEpoch, 1),
      [
        ...apps.map((a) => ({ kind: "app" as const, ...a })),
        ...dbs.map((d) => ({
          kind: "database" as const,
          id: d.id,
          replicas: 1,
        })),
      ],
    );
    return { apps: apps.length, databases: dbs.length };
  });

  const members = await readMembers(clusterId);
  const member = members.find((m) => m.serverId === serverId)!;
  await recordActivity(
    "server",
    `Added server ${server.name} to cluster ${cluster.name}` +
      (came.apps + came.databases > 0
        ? ` with ${came.apps} app${came.apps === 1 ? "" : "s"} and ${came.databases} database${came.databases === 1 ? "" : "s"}`
        : ""),
    user.name,
    null,
    teamId,
  );
  // The member's own change already happened: the sweep puts the roster right if a relay is down.
  try {
    const push = await pushClusterRoster(
      clusterId,
      members.map((m) => m.serverId),
    );
    for (const f of push.failed)
      console.warn(`[cluster-relay] ${clusterId}: ${f.serverId} ${f.message}`);
  } catch (e) {
    console.warn(
      `[cluster-relay] ${clusterId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return {
    member,
    ...came,
    note: failoverOn(members.length)
      ? null
      : "Failover starts at two members. Add another server to turn it on.",
  };
}
