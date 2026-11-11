import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterImageCopies,
  clusterMembers as membersTable,
  workloadPlacements,
} from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { peakMemoryMb } from "../../monitoring/container-history";

/** The least memory a workload is assumed to need; the leader's rule uses the same floor. */
export const MIN_WORKLOAD_MB = 256;

/** The room one replica needs: its memory limit, else its 24-hour peak, never below the floor. */
export function neededMb(
  id: string,
  limitMb: number | null | undefined,
  replicas = 1,
): number {
  return Math.max(limitMb || peakMemoryMb(id, replicas), MIN_WORKLOAD_MB);
}

/** What the leader's placement rule needs to know about one member, as of now. Internal: callers hold the gates. */
export interface MemberFact {
  id: string;
  arch: string;
  freeMb: number;
  images: string[];
  emptying: boolean;
  databaseEnvs: string[];
  workloads: number;
}

export async function clusterMemberFacts(
  clusterId: string,
): Promise<MemberFact[]> {
  const db = getDb();
  const members = await db
    .select({
      id: membersTable.serverId,
      arch: serversTable.hostArch,
      memoryMb: serversTable.memoryMb,
      emptying: membersTable.emptyingSince,
    })
    .from(membersTable)
    .innerJoin(serversTable, eq(serversTable.id, membersTable.serverId))
    .where(eq(membersTable.clusterId, clusterId))
    .orderBy(asc(membersTable.joinedAt), asc(membersTable.serverId));
  const ids = members.map((m) => m.id);
  if (ids.length === 0) return [];
  const [copies, placed] = await Promise.all([
    db
      .select({
        serverId: clusterImageCopies.serverId,
        ref: clusterImageCopies.imageRef,
      })
      .from(clusterImageCopies)
      .where(
        and(
          inArray(clusterImageCopies.serverId, ids),
          eq(clusterImageCopies.state, "held"),
        ),
      ),
    db
      .select({
        kind: workloadPlacements.kind,
        id: workloadPlacements.workloadId,
        member: workloadPlacements.memberServerId,
      })
      .from(workloadPlacements)
      .where(inArray(workloadPlacements.memberServerId, ids)),
  ]);
  const appIds = placed.filter((p) => p.kind === "app").map((p) => p.id);
  const dbIds = placed.filter((p) => p.kind === "database").map((p) => p.id);
  const [apps, dbs] = await Promise.all([
    appIds.length
      ? db
          .select({
            id: appsTable.id,
            limit: appsTable.resourceMemLimitMb,
            replicas: appsTable.replicas,
          })
          .from(appsTable)
          .where(inArray(appsTable.id, appIds))
      : [],
    dbIds.length
      ? db
          .select({
            id: databasesTable.id,
            limit: databasesTable.resourceMemLimitMb,
            env: databasesTable.environmentId,
          })
          .from(databasesTable)
          .where(inArray(databasesTable.id, dbIds))
      : [],
  ]);
  const need = new Map<string, number>();
  for (const a of apps) need.set(a.id, neededMb(a.id, a.limit, a.replicas));
  for (const d of dbs) need.set(d.id, neededMb(d.id, d.limit));
  const envOf = new Map(dbs.map((d) => [d.id, d.env]));
  return members.map((m) => {
    const mine = placed.filter((p) => p.member === m.id);
    const used = mine.reduce((n, p) => n + (need.get(p.id) ?? 0), 0);
    return {
      id: m.id,
      arch: m.arch,
      freeMb: Math.max(m.memoryMb - used, 0),
      images: [
        ...new Set(copies.filter((c) => c.serverId === m.id).map((c) => c.ref)),
      ],
      emptying: Boolean(m.emptying),
      databaseEnvs: [
        ...new Set(
          mine
            .filter((p) => p.kind === "database")
            .map((p) => envOf.get(p.id))
            .filter((e): e is string => Boolean(e)),
        ),
      ],
      workloads: mine.length,
    };
  });
}
