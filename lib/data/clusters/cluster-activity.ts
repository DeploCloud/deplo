import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import { recordActivity } from "../activity";
import { getClusterTeamIds } from "./roster";

/** Who reads what Deplo says about a cluster: the teams with work on it and the admin's, else the teams it is shared with. */
export async function clusterActivityTeamIds(
  clusterId: string,
): Promise<string[]> {
  const db = getDb();
  const [cluster] = await db
    .select({ leaderTeamId: clustersTable.leaderTeamId })
    .from(clustersTable)
    .where(eq(clustersTable.id, clusterId))
    .limit(1);
  const using = [
    ...(await db
      .selectDistinct({ teamId: appsTable.teamId })
      .from(appsTable)
      .where(eq(appsTable.clusterId, clusterId))),
    ...(await db
      .selectDistinct({ teamId: databasesTable.teamId })
      .from(databasesTable)
      .where(eq(databasesTable.clusterId, clusterId))),
  ].map((r) => r.teamId);
  const teams = [
    ...new Set([
      ...using,
      ...(cluster?.leaderTeamId ? [cluster.leaderTeamId] : []),
    ]),
  ];
  return teams.length > 0 ? teams.sort() : getClusterTeamIds(clusterId);
}

/** An Activity entry by Deplo about a cluster, one per team that reads it; never the instance's oldest team by default. */
export async function recordClusterActivity(
  clusterId: string,
  message: string,
): Promise<void> {
  const teams = await clusterActivityTeamIds(clusterId);
  // Nobody uses it and it is shared with everyone: the default team may read it like any other.
  if (teams.length === 0) return recordActivity("server", message, "Deplo");
  for (const teamId of teams)
    await recordActivity("server", message, "Deplo", null, teamId);
}
