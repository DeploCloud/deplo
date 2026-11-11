import "server-only";

import { and, eq, isNotNull } from "drizzle-orm";

import { recordActivity } from "../../data/activity";
import { getServerById } from "../../data/servers/roster";
import { teardownOrQueue } from "../../data/teardown-queue";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { publishAppChanged } from "../../graphql/pubsub";
import { nowIso } from "../../ids";
import { deployPreviewRow } from "./deploy";
import { previewTeardown } from "./placement";
import { hasStack } from "./slots";
import { cancelQueuedPreviewDeploys } from "./stack-teardown";

// https://deplo.build/docs/operations/clusters/logs-metrics-and-previews#pull-request-previews

/**
 * A server stopped or is gone: the previews running on it read "Offline: its server stopped" until the next
 * push or a redeploy places them again. Nothing is moved, since a preview never fails over.
 */
export async function markPreviewsOffline(serverId: string): Promise<void> {
  const rows = await getDb()
    .update(appPreviewsTable)
    .set({ status: "offline", updatedAt: nowIso() })
    .where(
      and(
        eq(appPreviewsTable.serverId, serverId),
        eq(appPreviewsTable.state, "open"),
        eq(appPreviewsTable.status, "active"),
      ),
    )
    .returning({ appId: appPreviewsTable.appId });
  for (const appId of new Set(rows.map((r) => r.appId)))
    publishAppChanged(appId);
}

/**
 * A member is being emptied or has left its cluster: each preview running on it is deployed again, which
 * places it on another member. One that no member can take is taken down, and Activity says why.
 */
export async function movePreviewsOff(serverId: string): Promise<void> {
  const rows = await getDb()
    .select({
      p: appPreviewsTable,
      name: appsTable.name,
      teamId: appsTable.teamId,
    })
    .from(appPreviewsTable)
    .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId))
    .where(
      and(
        eq(appPreviewsTable.serverId, serverId),
        eq(appPreviewsTable.state, "open"),
        isNotNull(appsTable.clusterId),
      ),
    );
  const server = (await getServerById(serverId))?.name ?? "its server";
  for (const { p, ...app } of rows) {
    if (!hasStack(p)) continue;
    try {
      await deployPreviewRow(p.id, {
        actor: "Deplo",
        commitMessage: "Move to a different server",
      });
    } catch (e) {
      await cancelQueuedPreviewDeploys(p.id);
      await teardownOrQueue(previewTeardown(p, app, serverId)).catch(
        () => false,
      );
      await getDb()
        .update(appPreviewsTable)
        .set({ status: "offline", tornDownAt: nowIso(), updatedAt: nowIso() })
        .where(eq(appPreviewsTable.id, p.id));
      publishAppChanged(p.appId);
      await recordActivity(
        "deployment",
        `Took down the preview for pull request #${p.prNumber} of ${app.name} on ${server}: ${e instanceof Error ? e.message : String(e)}`,
        "Deplo",
        p.appId,
      );
    }
  }
}
