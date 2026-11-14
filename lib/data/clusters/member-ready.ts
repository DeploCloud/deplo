import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb } from "../../db/client";
import { clusterMembers as membersTable } from "../../db/schema/control-plane/clusters";
import { nowIso } from "../../ids";
import type { Cluster } from "../../types/cluster";
import { readLeaderSnapshot } from "./leader-sync";

/**
 * A server that joined reads Provisioning until the cluster's leader answers for it. Marks each one it now does;
 * returns how many. Internal: the callers hold the gates.
 */
export async function settleProvisioningMembers(
  cluster: Cluster,
): Promise<number> {
  const db = getDb();
  const waiting = await db
    .select({ id: membersTable.serverId })
    .from(membersTable)
    .where(
      and(eq(membersTable.clusterId, cluster.id), isNull(membersTable.readyAt)),
    );
  if (waiting.length === 0) return 0;
  const view = (await readLeaderSnapshot(cluster))?.clusters[cluster.id];
  const answering = new Set(
    (view?.members ?? []).filter((m) => m.state === "ok").map((m) => m.id),
  );
  const ready = waiting.map((w) => w.id).filter((id) => answering.has(id));
  if (ready.length === 0) return 0;
  const rows = await db
    .update(membersTable)
    .set({ readyAt: nowIso() })
    .where(
      and(
        eq(membersTable.clusterId, cluster.id),
        inArray(membersTable.serverId, ready),
        isNull(membersTable.readyAt),
      ),
    )
    .returning({ id: membersTable.serverId });
  return rows.length;
}
