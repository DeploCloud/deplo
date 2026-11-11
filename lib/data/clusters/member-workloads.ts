import "server-only";

import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterMembers as membersTable,
  workloadPlacements,
} from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import type { WorkloadKind } from "./placement";

/** One App or database a member still holds. Internal: callers hold the gates. */
export interface MemberWorkload {
  kind: WorkloadKind;
  id: string;
  name: string;
  teamId: string;
  environmentId: string | null;
  /** The memory limit in MB; 0 when none is set. */
  limitMb: number;
  /** An App already deployed on another server whose data is still on this one. */
  leaving: boolean;
  /** An App with replicas on other servers too: only its replicas here move, with a deploy. */
  spread?: boolean;
}

/** What `serverId` holds, in the order an emptying moves it: databases, then Apps, oldest first. */
export async function listMemberWorkloads(
  serverId: string,
): Promise<MemberWorkload[]> {
  const db = getDb();
  // An App spread over several servers is held by each of them, not only the one it "runs on now".
  const placed = await db
    .select({
      id: workloadPlacements.workloadId,
      member: workloadPlacements.memberServerId,
    })
    .from(workloadPlacements)
    .innerJoin(appsTable, eq(appsTable.id, workloadPlacements.workloadId))
    .innerJoin(membersTable, eq(membersTable.clusterId, appsTable.clusterId))
    .where(
      and(
        eq(workloadPlacements.kind, "app"),
        eq(membersTable.serverId, serverId),
      ),
    );
  const here = [
    ...new Set(placed.filter((p) => p.member === serverId).map((p) => p.id)),
  ];
  const spread = new Set(
    here.filter((id) =>
      placed.some((p) => p.id === id && p.member && p.member !== serverId),
    ),
  );
  const [dbs, apps] = await Promise.all([
    db
      .select({
        id: databasesTable.id,
        name: databasesTable.name,
        teamId: databasesTable.teamId,
        environmentId: databasesTable.environmentId,
        limitMb: databasesTable.resourceMemLimitMb,
      })
      .from(databasesTable)
      .where(eq(databasesTable.serverId, serverId))
      .orderBy(asc(databasesTable.createdAt), asc(databasesTable.id)),
    db
      .select({
        id: appsTable.id,
        name: appsTable.name,
        teamId: appsTable.teamId,
        environmentId: appsTable.environmentId,
        limitMb: appsTable.resourceMemLimitMb,
        serverId: appsTable.serverId,
      })
      .from(appsTable)
      .where(
        and(
          isNull(appsTable.deletingAt),
          or(
            eq(appsTable.serverId, serverId),
            eq(appsTable.migrateFromServerId, serverId),
            here.length > 0 ? inArray(appsTable.id, here) : undefined,
          ),
        ),
      )
      .orderBy(asc(appsTable.createdAt), asc(appsTable.id)),
  ]);
  return [
    ...dbs.map((d) => ({
      kind: "database" as const,
      ...d,
      limitMb: d.limitMb ?? 0,
      leaving: false,
    })),
    ...apps.map(({ serverId: on, ...a }) => ({
      kind: "app" as const,
      ...a,
      limitMb: a.limitMb ?? 0,
      leaving: on !== serverId && !spread.has(a.id),
      ...(spread.has(a.id) ? { spread: true } : {}),
    })),
  ];
}

/** True while `serverId` is being emptied: nothing new is placed on it. */
export async function memberIsEmptying(serverId: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: membersTable.serverId })
    .from(membersTable)
    .where(
      and(
        eq(membersTable.serverId, serverId),
        isNotNull(membersTable.emptyingSince),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
