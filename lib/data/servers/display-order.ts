import "server-only";

import { asc, eq, isNotNull, sql } from "drizzle-orm";

import { getDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { requireInstanceAdmin } from "../../membership";
import { requireExperiment } from "../experiments";
import { mergeOrder } from "../folders";

/** One order for every admin: the ids given lead, the rest keep theirs after them. */
async function savePositions(
  table: typeof serversTable | typeof clustersTable,
  orderedIds: string[],
): Promise<void> {
  await getDb().transaction(async (tx) => {
    const all = await tx
      .select({ id: table.id })
      .from(table)
      .orderBy(
        sql`${table.position} asc nulls last`,
        asc(table.createdAt),
        asc(table.id),
      );
    const next = mergeOrder(
      orderedIds,
      all.map((r) => r.id),
    );
    for (const [position, id] of next.entries())
      await tx.update(table).set({ position }).where(eq(table.id, id));
  });
}

export async function reorderServers(orderedIds: string[]): Promise<void> {
  await requireInstanceAdmin();
  await savePositions(serversTable, orderedIds);
}

export async function reorderClusters(orderedIds: string[]): Promise<void> {
  await requireInstanceAdmin();
  await requireExperiment("clusters");
  await savePositions(clustersTable, orderedIds);
}

/** Where each placed server and cluster sits; one never placed is absent. */
export async function displayPositions(): Promise<{
  servers: Map<string, number>;
  clusters: Map<string, number>;
}> {
  await requireInstanceAdmin();
  const [servers, clusters] = await Promise.all([
    getDb()
      .select({ id: serversTable.id, position: serversTable.position })
      .from(serversTable)
      .where(isNotNull(serversTable.position)),
    getDb()
      .select({ id: clustersTable.id, position: clustersTable.position })
      .from(clustersTable)
      .where(isNotNull(clustersTable.position)),
  ]);
  return {
    servers: new Map(servers.map((r) => [r.id, r.position!])),
    clusters: new Map(clusters.map((r) => [r.id, r.position!])),
  };
}
