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
  // Claim and queue under the lock eviction takes: a sibling's eviction wrote `queued` over `evicted`.
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
    if (!fresh || fresh.state !== "open") return null;
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
