import "server-only";

import { and, eq, isNotNull, isNull, lt, ne, or } from "drizzle-orm";

import { getDb } from "../../db/client";
import {
  clusterJoinRequests as requestsTable,
  clusters as clustersTable,
} from "../../db/schema/control-plane/clusters";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { runWithIdentity } from "../../auth/request-context";
import { getCurrentUser } from "../../auth/current-user";
import { requireActiveTeamId, requireInstanceAdmin } from "../../membership";
import { nowIso } from "../../ids";
import { messageOf } from "../../utils";
import { recordActivity } from "../activity";
import { requireExperiment } from "../experiments";
import { onAgentLink } from "../../infra/agent-link/registry";
import { withKeyedLock } from "../keyed-mutex";
import { addClusterMember } from "./members";

// A refused join is asked again at most this often: a reason like an old agent goes away on its own.
const RETRY_MS = 60_000;

/** Checked before a server is added for a cluster, so a refusal leaves no half-added server behind. */
export async function assertJoinableCluster(clusterId: string): Promise<void> {
  await requireInstanceAdmin();
  await requireExperiment("clusters");
  const [cluster] = await getDb()
    .select({ id: clustersTable.id })
    .from(clustersTable)
    .where(eq(clustersTable.id, clusterId))
    .limit(1);
  if (!cluster) throw new Error("Cluster not found");
}

/** Asks for a server just added to join `clusterId` once it is installed and answers. */
export async function requestClusterJoin(
  serverId: string,
  clusterId: string,
): Promise<void> {
  await assertJoinableCluster(clusterId);
  const { userId } = await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  await getDb()
    .insert(requestsTable)
    .values({
      serverId,
      clusterId,
      requestedByUserId: userId,
      requestedByTeamId: teamId,
      requestedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: requestsTable.serverId,
      set: {
        clusterId,
        requestedByUserId: userId,
        requestedByTeamId: teamId,
        error: "",
      },
    });
}

export async function cancelClusterJoin(serverId: string): Promise<void> {
  await requireInstanceAdmin();
  const teamId = await requireActiveTeamId();
  const user = (await getCurrentUser())!;
  const gone = await getDb()
    .delete(requestsTable)
    .where(eq(requestsTable.serverId, serverId))
    .returning({ clusterId: requestsTable.clusterId });
  if (gone.length === 0) return;
  const [names] = await getDb()
    .select({ server: serversTable.name, cluster: clustersTable.name })
    .from(serversTable)
    .innerJoin(clustersTable, eq(clustersTable.id, gone[0].clusterId))
    .where(eq(serversTable.id, serverId));
  if (names)
    await recordActivity(
      "server",
      `${names.server} will not join cluster ${names.cluster}`,
      user.name,
      null,
      teamId,
    );
}

export interface ClusterJoinRequest {
  clusterId: string;
  clusterName: string;
  error: string;
}

export async function listClusterJoinRequests(): Promise<
  Map<string, ClusterJoinRequest>
> {
  await requireInstanceAdmin();
  const rows = await getDb()
    .select({
      serverId: requestsTable.serverId,
      clusterId: requestsTable.clusterId,
      clusterName: clustersTable.name,
      error: requestsTable.error,
    })
    .from(requestsTable)
    .innerJoin(clustersTable, eq(clustersTable.id, requestsTable.clusterId));
  return new Map(rows.map(({ serverId, ...r }) => [serverId, r]));
}

/**
 * The background half: every waiting server that is installed and answers joins, as the person who asked. `linked`
 * is one whose agent link just came up: it joins now, not at the next tick (c48: 23 s later).
 */
export async function joinWaitingServers(
  now = Date.now(),
  linked?: string,
): Promise<number> {
  const due = new Date(now - RETRY_MS).toISOString();
  const waiting = await getDb()
    .select({
      serverId: requestsTable.serverId,
      clusterId: requestsTable.clusterId,
      userId: requestsTable.requestedByUserId,
      teamId: requestsTable.requestedByTeamId,
    })
    .from(requestsTable)
    .innerJoin(serversTable, eq(serversTable.id, requestsTable.serverId))
    .where(
      and(
        isNotNull(serversTable.agentCertFingerprint),
        ne(serversTable.agentCertFingerprint, ""),
        linked
          ? eq(requestsTable.serverId, linked)
          : and(
              eq(serversTable.status, "online"),
              or(isNull(requestsTable.triedAt), lt(requestsTable.triedAt, due)),
            ),
      ),
    );
  let joined = 0;
  for (const w of waiting) {
    const row = eq(requestsTable.serverId, w.serverId);
    if (!w.userId || !w.teamId) {
      await getDb()
        .update(requestsTable)
        .set({
          error:
            "Whoever asked for it is no longer here. Move it into the cluster again.",
          triedAt: nowIso(),
        })
        .where(row);
      continue;
    }
    const { userId, teamId } = w;
    try {
      // A tick and a link can both find it: the second finds no request left.
      const done = await withKeyedLock(
        `cluster-join:${w.serverId}`,
        async () => {
          const [still] = await getDb()
            .select({ serverId: requestsTable.serverId })
            .from(requestsTable)
            .where(row);
          if (!still) return false;
          await runWithIdentity({ userId, teamId }, () =>
            addClusterMember(w.clusterId, w.serverId),
          );
          await getDb().delete(requestsTable).where(row);
          return true;
        },
      );
      if (done) joined++;
    } catch (e) {
      await getDb()
        .update(requestsTable)
        .set({ error: messageOf(e), triedAt: nowIso() })
        .where(row);
    }
  }
  return joined;
}

/** Joins a waiting server as soon as its agent links; `holds` says whether this Deplo runs the cluster watch. */
export function joinOnLink(holds: () => boolean): () => void {
  return onAgentLink((e) => {
    if (e.type !== "up" || !holds()) return;
    void joinWaitingServers(Date.now(), e.serverId).catch((err) =>
      console.warn(`[cluster] joining ${e.serverId}: ${messageOf(err)}`),
    );
  });
}
