import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import { askLeaderToPlace } from "../../data/clusters/placement";
import { listClustersForTeam } from "../../data/clusters/roster";
import { serverWildcardIp } from "../../data/servers/addresses";
import { getServerById } from "../../data/servers/roster";
import { teardownOrQueue } from "../../data/teardown-queue";
import { getDb } from "../../db/client";
import { clusterMembers } from "../../db/schema/control-plane/clusters";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { nowIso } from "../../ids";
import type { App } from "../../types/app";
import { rehostWildcard } from "../domains";
import { previewSettings } from "./settings";

// https://deplo.build/docs/operations/clusters#pull-request-previews

type Preview = typeof appPreviewsTable.$inferSelect;

export const CLUSTER_NOT_AVAILABLE =
  "That cluster isn't available to this team.";

/** True while the member can go on running the preview it has: in the cluster, answering, not being emptied. */
async function memberStillServes(
  clusterId: string,
  serverId: string,
): Promise<boolean> {
  const rows = await getDb()
    .select({ id: clusterMembers.serverId })
    .from(clusterMembers)
    .where(
      and(
        eq(clusterMembers.clusterId, clusterId),
        eq(clusterMembers.serverId, serverId),
        eq(clusterMembers.leaseState, "ok"),
        isNull(clusterMembers.emptyingSince),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// The leader picks and keeps no record, so nothing of a preview is ever moved or failed over.
// ponytail: a preview's memory is not counted against a member's room; add it to facts.ts if previews crowd one.
// ponytail: no architecture is sent; which processors a build runs on is #207's.
async function memberFor(p: Preview, app: App): Promise<string> {
  if (
    p.serverId &&
    p.status !== "offline" &&
    (await memberStillServes(app.clusterId!, p.serverId))
  )
    return p.serverId;
  const cluster = (await listClustersForTeam(app.teamId)).find(
    (c) => c.id === app.clusterId,
  );
  if (!cluster) throw new Error(CLUSTER_NOT_AVAILABLE);
  return askLeaderToPlace(cluster, {
    kind: "app",
    id: p.id,
    name: app.name,
    environmentId: null,
    limitMb: app.resources?.memoryMb ?? 0,
  });
}

/** The entry that removes a preview's stack from the server it is on, now or once that server answers. */
export function previewTeardown(
  p: Pick<Preview, "id" | "deployKey" | "prNumber">,
  app: Pick<App, "name" | "teamId">,
  serverId: string,
) {
  return {
    serverId,
    deployKey: p.deployKey,
    projectLabel: p.id,
    label: `the preview for pull request #${p.prNumber} of ${app.name}`,
    teamId: app.teamId,
  };
}

/**
 * Where this deploy of the preview runs: the server picked in its settings, else a member the cluster's leader
 * names, else the App's server. A stack left on another server is removed and a generated address follows.
 */
export async function placePreview(
  previewId: string,
  app: App,
): Promise<{ serverId: string; host: string }> {
  // Read here, under the caller's lock: a deploy just before this one may have moved it.
  const [p] = await getDb()
    .select()
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.id, previewId))
    .limit(1);
  if (!p) throw new Error("Preview not found");
  const own = (await previewSettings(p.appId))?.serverId ?? null;
  const serverId =
    own ?? (app.clusterId ? await memberFor(p, app) : app.serverId);
  if (serverId === p.serverId) return { serverId, host: p.host };
  if (p.serverId && !p.tornDownAt)
    await teardownOrQueue(previewTeardown(p, app, p.serverId)).catch(
      () => false,
    );
  const ip = await serverWildcardIp(await getServerById(serverId));
  const host = ip ? rehostWildcard(p.host, ip) : p.host;
  await getDb()
    .update(appPreviewsTable)
    .set({ serverId, host, updatedAt: nowIso() })
    .where(eq(appPreviewsTable.id, p.id));
  return { serverId, host };
}
