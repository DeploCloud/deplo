import "server-only";

import { and, eq, notInArray } from "drizzle-orm";

import { teardownApp } from "../../data/deployments/stack-actions";
import { getDb } from "../../db/client";
import {
  appPreviews as appPreviewsTable,
  deployments as deploymentsTable,
} from "../../db/schema/control-plane/deployments";
import { nowIso } from "../../ids";

// Destroy a preview's stack on its host and stamp `torn_down_at` on success. A
// preview's volumes were created by, and only by, that preview; nobody asked to keep
// their contents and nothing would ever point at them again.
export async function teardownPreviewStack(p: {
  id: string;
  deployKey: string;
  tornDownAt: string | null;
}): Promise<boolean> {
  if (p.tornDownAt) return true;
  // Never built ⇒ nothing on any host. Asking the agent to `down -v` a stack with
  // no file reports a failure, and the reaper would repeat it every hour.
  const built = await getDb()
    .select({ id: deploymentsTable.id })
    .from(deploymentsTable)
    .where(
      and(
        eq(deploymentsTable.previewId, p.id),
        notInArray(deploymentsTable.status, ["queued", "canceled"]),
      ),
    )
    .limit(1);
  const ok =
    built.length === 0 ||
    (await teardownApp(p.deployKey, { removeVolumes: true }));
  if (ok) {
    await getDb()
      .update(appPreviewsTable)
      .set({ tornDownAt: nowIso(), updatedAt: nowIso() })
      .where(eq(appPreviewsTable.id, p.id));
  }
  return ok;
}

// Nothing queued for a preview that is going down should ever start building.
export async function cancelQueuedPreviewDeploys(
  previewId: string,
): Promise<void> {
  await getDb()
    .update(deploymentsTable)
    .set({ status: "canceled" })
    .where(
      and(
        eq(deploymentsTable.previewId, previewId),
        eq(deploymentsTable.status, "queued"),
      ),
    );
}

// Take a preview's stack down while its pull request stays open, keeping its key and
// host so Redeploy brings the same URL back. Stamped FIRST, then torn down: an
// unreachable host leaves `torn_down_at` NULL, which is what the reaper retries on.
export async function stopPreview(
  p: { id: string; deployKey: string; tornDownAt: string | null },
  status: "evicted" | "blocked",
): Promise<boolean> {
  await getDb()
    .update(appPreviewsTable)
    .set({ status, updatedAt: nowIso() })
    .where(eq(appPreviewsTable.id, p.id));
  await cancelQueuedPreviewDeploys(p.id);
  return teardownPreviewStack(p);
}
