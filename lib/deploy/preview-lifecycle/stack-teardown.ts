import "server-only";

import { and, eq, notInArray } from "drizzle-orm";

import { teardownApp } from "../../data/deployments/stack-actions";
import { getDb } from "../../db/client";
import {
  appPreviews as appPreviewsTable,
  deployments as deploymentsTable,
} from "../../db/schema/control-plane/deployments";
import { nowIso } from "../../ids";

export async function teardownPreviewStack(p: {
  id: string;
  deployKey: string;
  tornDownAt: string | null;
}): Promise<boolean> {
  if (p.tornDownAt) return true;
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
