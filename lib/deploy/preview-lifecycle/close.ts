import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import { recordActivity } from "../../data/activity";
import { loadAppGraph } from "../../data/app-graph-load";
import { getServerById } from "../../data/servers/roster";
import { teardownOrQueue } from "../../data/teardown-queue";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { nowIso } from "../../ids";
import { publishAppChanged } from "../../graphql/pubsub";
import { syncPreviewComment } from "../preview-comment";
import { rehostNip, resolveServerIp } from "../domains";
import { mapLimit } from "../../utils";
import { PREVIEW_MAX_ACTIVE_DEFAULT, previewSettings } from "./settings";
import { hasStack } from "./slots";
import {
  cancelQueuedPreviewDeploys,
  stopPreview,
  teardownPreviewStack,
} from "./stack-teardown";

export async function closePreview(
  previewId: string,
  reason: string,
): Promise<boolean> {
  const rows = await getDb()
    .select()
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.id, previewId))
    .limit(1);
  const p = rows[0];
  if (!p) return true;
  const now = nowIso();
  await getDb()
    .update(appPreviewsTable)
    .set({
      state: "closed",
      status: "idle",
      closedAt: p.closedAt ?? now,
      updatedAt: now,
    })
    .where(eq(appPreviewsTable.id, previewId));
  await cancelQueuedPreviewDeploys(previewId);
  const gone = await teardownPreviewStack(p);
  publishAppChanged(p.appId);
  void syncPreviewComment(previewId, { kind: "destroyed" });
  const app = await loadAppGraph(p.appId);
  await recordActivity(
    "deployment",
    gone
      ? `Destroyed the preview for pull request #${p.prNumber}${app ? ` of ${app.name}` : ""} (${reason})`
      : `Could not reach the server to destroy the preview for pull request #${p.prNumber}` +
          `${app ? ` of ${app.name}` : ""} - Deplo will retry`,
    "system",
    p.appId,
  );
  return gone;
}

export async function stopPreviewsForServerChange(
  appId: string,
  newServerId: string,
): Promise<number> {
  const rows = await getDb()
    .select({
      id: appPreviewsTable.id,
      deployKey: appPreviewsTable.deployKey,
      tornDownAt: appPreviewsTable.tornDownAt,
      status: appPreviewsTable.status,
      latestDeploymentId: appPreviewsTable.latestDeploymentId,
      host: appPreviewsTable.host,
      url: appPreviewsTable.url,
    })
    .from(appPreviewsTable)
    .where(
      and(
        eq(appPreviewsTable.appId, appId),
        eq(appPreviewsTable.state, "open"),
      ),
    );
  const victims = rows.filter(hasStack);
  const settings = await previewSettings(appId);
  for (const v of victims) {
    await stopPreview(v, "evicted");
    void syncPreviewComment(v.id, {
      kind: "evicted",
      max: settings?.maxActive ?? PREVIEW_MAX_ACTIVE_DEFAULT,
    });
  }
  const newIp = resolveServerIp(
    (await getServerById(newServerId)) ?? undefined,
  );
  for (const r of rows) {
    const host = rehostNip(r.host, newIp);
    if (host === r.host) continue;
    await getDb()
      .update(appPreviewsTable)
      .set({
        host,
        url: r.url ? r.url.replace(r.host, host) : r.url,
        updatedAt: nowIso(),
      })
      .where(eq(appPreviewsTable.id, r.id));
  }
  if (victims.length > 0) publishAppChanged(appId);
  return victims.length;
}

export async function destroyPreviewsForApp(appId: string): Promise<void> {
  const rows = await getDb()
    .select({
      id: appPreviewsTable.id,
      deployKey: appPreviewsTable.deployKey,
      prNumber: appPreviewsTable.prNumber,
      appName: appsTable.name,
      teamId: appsTable.teamId,
      serverId: sql<string>`coalesce(${appsTable.previewServerId}, ${appsTable.serverId})`,
    })
    .from(appPreviewsTable)
    .innerJoin(appsTable, eq(appsTable.id, appPreviewsTable.appId))
    .where(
      and(
        eq(appPreviewsTable.appId, appId),
        isNull(appPreviewsTable.tornDownAt),
      ),
    );
  await mapLimit(rows, 4, async (r) => {
    await syncPreviewComment(r.id, { kind: "destroyed" });
    await teardownOrQueue({
      serverId: r.serverId,
      deployKey: r.deployKey,
      projectLabel: r.id,
      label: `the preview for pull request #${r.prNumber} of ${r.appName}`,
      teamId: r.teamId,
    }).catch(() => false);
  });
}
