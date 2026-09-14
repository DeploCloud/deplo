import "server-only";

import { and, eq } from "drizzle-orm";

import { withKeyedLock } from "../../data/keyed-mutex";
import { getDb } from "../../db/client";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { nowIso } from "../../ids";
import { publishAppChanged } from "../../graphql/pubsub";
import type { CertProvider } from "../../types/domain";
import { startDeployment } from "../build/deploy-start";
import { forkRefusal, refusalMessage } from "./fork-guard";
import { PREVIEW_MAX_ACTIVE_DEFAULT, previewSettings } from "./settings";
import { SLOTLESS, countOpenPreviews, evictToFit } from "./slots";

// Queue a build for an EXISTING preview row (a resync, a manual redeploy, or the first
// build right after an approval). Reads the row for the facts the deploy needs.
export async function deployPreviewRow(
  previewId: string,
  opts: {
    actor: string;
    actorProvider?: string | null;
    commitMessage?: string;
  },
): Promise<string | null> {
  const row = await getDb()
    .select()
    .from(appPreviewsTable)
    .where(eq(appPreviewsTable.id, previewId))
    .limit(1);
  const p = row[0];
  if (!p) return null;
  const settings = await previewSettings(p.appId);
  const max = settings?.maxActive ?? PREVIEW_MAX_ACTIVE_DEFAULT;
  // The whole claim-and-queue under the per-app lock, the same one eviction takes:
  // a sibling's eviction landing in between let `startDeployment` write `queued` over
  // `evicted` - twelve stacks under a cap of five.
  return withKeyedLock(`preview-cap:${p.appId}`, async () => {
    const fresh = (
      await getDb()
        .select({
          status: appPreviewsTable.status,
          state: appPreviewsTable.state,
        })
        .from(appPreviewsTable)
        .where(eq(appPreviewsTable.id, previewId))
        .limit(1)
    )[0];
    // Closed while it waited for the lock: nothing to build.
    if (!fresh || fresh.state !== "open") return null;
    // A preview that holds no slot is about to start holding one, so it claims its
    // place exactly like a new preview would: otherwise reviving an evicted one, or
    // approving a fork sitting blocked, would silently put the app over its cap.
    if ((SLOTLESS as readonly string[]).includes(fresh.status)) {
      if ((await countOpenPreviews(p.appId)) >= max)
        await evictToFit(p.appId, max, max);
      await getDb()
        .update(appPreviewsTable)
        .set({ status: "queued", updatedAt: nowIso() })
        .where(eq(appPreviewsTable.id, previewId));
    }
    return startPreviewDeployment(p, opts);
  });
}

async function startPreviewDeployment(
  p: typeof appPreviewsTable.$inferSelect,
  opts: {
    actor: string;
    actorProvider?: string | null;
    commitMessage?: string;
  },
): Promise<string> {
  const previewId = p.id;
  try {
    // Every manual path (Redeploy, Approve) lands here too.
    if (p.isFork) {
      const refusal = await forkRefusal(p.appId);
      if (refusal) throw new Error(refusalMessage(refusal));
    }
    return await startDeployment(p.appId, {
      environment: "preview",
      creator: opts.actor,
      creatorProvider: opts.actorProvider,
      commitMessage:
        opts.commitMessage || p.prTitle || `Pull request #${p.prNumber}`,
      branch: p.headBranch,
      preview: {
        id: p.id,
        deployKey: p.deployKey,
        host: p.host,
        certProvider: p.certProvider as CertProvider,
        prNumber: p.prNumber,
        headSha: p.headSha,
        serverId: (await previewSettings(p.appId))?.serverId ?? null,
      },
    });
  } catch (e) {
    // A refusal before the row was even queued (a revoked host grant, a migration
    // still running) must not leave the list saying "queued" with nothing behind it.
    await getDb()
      .update(appPreviewsTable)
      .set({ status: "error", updatedAt: nowIso() })
      .where(
        and(
          eq(appPreviewsTable.id, previewId),
          eq(appPreviewsTable.status, "queued"),
        ),
      );
    publishAppChanged(p.appId);
    throw e;
  }
}
