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

// Close a preview: stop accepting builds for it, cancel anything still queued, and
// tear the stack down.
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
  // Every way a preview closes tells the pull request, not only the webhook's:
  // the reaper's idle timeout and the Destroy button left a "Ready" link that 404s.
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

// Stop every running preview of an app because the machine they run on is about to
// change. Their stacks live on the OLD host and every lifecycle verb resolves the host
// from the app row, so this MUST run BEFORE that row is written.
export async function stopPreviewsForServerChange(
  appId: string,
  // The server previews will run on from now on.
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
  // A nip.io host carries the server's IP in its last label, so a preview minted
  // on the old machine would keep resolving THERE after Redeploy built it here.
  // Same re-host an app's own auto domains get on a move; a base-domain host is
  // the operator's DNS and stays.
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

// Tear down every preview stack of an app, for the paths that delete the app itself.
// MUST run before the app row goes: the FK cascade drops the preview rows, and with
// them the only record that those containers and volumes exist.
export async function destroyPreviewsForApp(appId: string): Promise<void> {
  const rows = await getDb()
    .select({
      id: appPreviewsTable.id,
      deployKey: appPreviewsTable.deployKey,
      prNumber: appPreviewsTable.prNumber,
      appName: appsTable.name,
      teamId: appsTable.teamId,
      // Previews may be pinned to their own machine (`preview_server_id`), which
      // is where `startDeployment` sent this stack.
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
  // The queue, not `teardownPreviewStack`: these rows are about to CASCADE away with
  // the app, so the stamp they retry on is gone in a moment and nothing would ever
  // name these containers again. The comment goes first, and is awaited: the row
  // it reads is what the cascade is about to drop.
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
