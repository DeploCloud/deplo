import "server-only";

import { and, asc, eq, inArray, or } from "drizzle-orm";
import { getDb } from "../../db/client";
import {
  clusterMembers as clusterMembersTable,
  clusterTeams as clusterTeamsTable,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { teams as teamsTable } from "../../db/schema/control-plane/identity";
import { teamAvatarUrl } from "../../avatar";
import { narrowedScope } from "../../auth/request-context";
import {
  isInstanceAdmin,
  reachesWholeTeam,
  requireActiveTeamId,
  requireInstanceAdmin,
  requireTeamWide,
} from "../../membership";
import type { Cluster } from "../../types/cluster";
import type { Team } from "../../types/team";

type Row = typeof clustersTable.$inferSelect;

function assemble(r: Row): Cluster {
  return {
    id: r.id,
    name: r.name,
    allTeams: r.allTeams,
    leaderServerId: r.leaderServerId,
    leaderEpoch: r.leaderEpoch,
    leaderTakeoverAt: r.leaderTakeoverAt,
    eventSeq: r.eventSeq,
    createdAt: r.createdAt,
  };
}

export async function getClusterById(id: string): Promise<Cluster | null> {
  const rows = await getDb()
    .select()
    .from(clustersTable)
    .where(eq(clustersTable.id, id))
    .limit(1);
  return rows[0] ? assemble(rows[0]) : null;
}

/** Every cluster on the instance: the Servers page's list, for an instance admin only. */
export async function listAllClusters(): Promise<Cluster[]> {
  await requireInstanceAdmin();
  const rows = await getDb()
    .select()
    .from(clustersTable)
    .orderBy(asc(clustersTable.createdAt), asc(clustersTable.id));
  return rows.map(assemble);
}

/** The clusters a team may use: shared with everyone, or granted to it. */
export async function listClustersForTeam(teamId: string): Promise<Cluster[]> {
  const db = getDb();
  const grantedToTeam = db
    .select({ id: clusterTeamsTable.clusterId })
    .from(clusterTeamsTable)
    .where(eq(clusterTeamsTable.teamId, teamId));
  const rows = await db
    .select()
    .from(clustersTable)
    .where(
      or(
        eq(clustersTable.allTeams, true),
        inArray(clustersTable.id, grantedToTeam),
      ),
    )
    .orderBy(asc(clustersTable.createdAt), asc(clustersTable.id));
  return rows.map(assemble);
}

export async function listClusters(): Promise<Cluster[]> {
  await requireTeamWide("clusters");
  const teamId = await requireActiveTeamId();
  return listClustersForTeam(teamId);
}

export async function getCluster(id: string): Promise<Cluster | null> {
  if (narrowedScope()) return null;
  if (!(await reachesWholeTeam())) return null;
  const teamId = await requireActiveTeamId();
  const cluster = await getClusterById(id);
  if (!cluster) return null;
  if (cluster.allTeams) return cluster;
  const granted = await getDb()
    .select({ teamId: clusterTeamsTable.teamId })
    .from(clusterTeamsTable)
    .where(
      and(
        eq(clusterTeamsTable.clusterId, id),
        eq(clusterTeamsTable.teamId, teamId),
      ),
    )
    .limit(1);
  return granted.length > 0 ? cluster : null;
}

/** The servers that are members of a cluster, in the order they joined. */
/** What the leader last said about each member's lease. */
export async function clusterLeaseStates(clusterId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ state: clusterMembersTable.leaseState })
    .from(clusterMembersTable)
    .where(eq(clusterMembersTable.clusterId, clusterId));
  return rows.map((r) => r.state);
}

export async function clusterMemberServerIds(
  clusterId: string,
): Promise<string[]> {
  const rows = await getDb()
    .select({ id: clusterMembersTable.serverId })
    .from(clusterMembersTable)
    .where(eq(clusterMembersTable.clusterId, clusterId))
    .orderBy(
      asc(clusterMembersTable.joinedAt),
      asc(clusterMembersTable.serverId),
    );
  return rows.map((r) => r.id);
}

export async function getClusterTeamIds(clusterId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ teamId: clusterTeamsTable.teamId })
    .from(clusterTeamsTable)
    .where(eq(clusterTeamsTable.clusterId, clusterId));
  return rows.map((r) => r.teamId);
}

export async function listAllClusterTeamIds(): Promise<Map<string, string[]>> {
  const rows = await getDb()
    .select({
      clusterId: clusterTeamsTable.clusterId,
      teamId: clusterTeamsTable.teamId,
    })
    .from(clusterTeamsTable);
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.clusterId);
    if (list) list.push(r.teamId);
    else map.set(r.clusterId, [r.teamId]);
  }
  return map;
}

// Only an instance admin sees the whole grant list; anyone else sees their own team at most.
export async function getClusterTeams(clusterId: string): Promise<Team[]> {
  const own = (await isInstanceAdmin()) ? null : await requireActiveTeamId();
  const rows = await getDb()
    .select({
      id: teamsTable.id,
      name: teamsTable.name,
      slug: teamsTable.slug,
      plan: teamsTable.plan,
      image: teamsTable.image,
      createdAt: teamsTable.createdAt,
    })
    .from(clusterTeamsTable)
    .innerJoin(teamsTable, eq(teamsTable.id, clusterTeamsTable.teamId))
    .where(
      and(
        eq(clusterTeamsTable.clusterId, clusterId),
        own ? eq(clusterTeamsTable.teamId, own) : undefined,
      ),
    )
    .orderBy(asc(teamsTable.name));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    plan: r.plan as Team["plan"],
    avatarUrl: teamAvatarUrl(r.image),
    createdAt: r.createdAt,
  }));
}
