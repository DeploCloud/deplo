import "server-only";

import { and, eq } from "drizzle-orm";

import { loadAppGraph } from "../../data/app-graph-load";
import { withKeyedLock } from "../../data/keyed-mutex";
import { getServerById } from "../../data/servers/roster";
import { getDb } from "../../db/client";
import { appPreviews as appPreviewsTable } from "../../db/schema/control-plane/deployments";
import { newId, nowIso } from "../../ids";
import { publishAppChanged } from "../../graphql/pubsub";
import { previewDeployKey } from "../deploy-key";
import { previewHost, resolveServerIp } from "../domains";
import { deployPreviewRow } from "./deploy";
import { forkRefusal, type PreviewRefusal } from "./fork-guard";
import { forkPolicyOf, previewSettings } from "./settings";
import { evictToFit, hasStack } from "./slots";
import { stopPreview } from "./stack-teardown";

export interface PullRequestFacts {
  number: number;
  title: string;
  author: string;
  url: string;
  headBranch: string;
  headSha: string;
  headRepo: string;
  headCloneUrl: string;
  baseBranch: string;
  isFork: boolean;
}

export interface OpenOrSyncResult {
  previewId: string | null;
  deploymentId: string | null;
  refusal?: PreviewRefusal;
}

export async function openOrSyncPreview(
  appId: string,
  pr: PullRequestFacts,
  opts: {
    actor: string;
    actorProvider?: string | null;
    approve?: boolean;
    manual?: boolean;
    build?: boolean;
  } = { actor: "github" },
): Promise<OpenOrSyncResult> {
  const syncOnly = opts.build === false;
  return withKeyedLock(`preview:${appId}:${pr.number}`, async () => {
    const app = await loadAppGraph(appId);
    if (!app) return { previewId: null, deploymentId: null };
    const settings = await previewSettings(appId);
    if (!settings) return { previewId: null, deploymentId: null };
    if (!settings.enabled) {
      return {
        previewId: null,
        deploymentId: null,
        refusal: { kind: "previews-off" },
      };
    }
    if (app.source !== "github" || !app.repo) {
      return {
        previewId: null,
        deploymentId: null,
        refusal: { kind: "not-github" },
      };
    }

    const existing = await loadPreviewRow(appId, pr.number);
    if (syncOnly && !existing) return { previewId: null, deploymentId: null };
    const policy = forkPolicyOf(settings.forkPolicy);
    if (pr.isFork && policy === "deny" && !opts.approve) {
      return {
        previewId: null,
        deploymentId: null,
        refusal: { kind: "fork-denied" },
      };
    }
    if (pr.isFork) {
      const refusal = await forkRefusal(appId);
      if (refusal)
        return { previewId: existing?.id ?? null, deploymentId: null, refusal };
    }
    const approved =
      !pr.isFork ||
      policy === "allow" ||
      opts.approve ||
      (Boolean(existing?.approvedSha) && existing?.approvedSha === pr.headSha);

    const now = nowIso();
    let previewId = existing?.id ?? null;
    const evictedAndUnasked = existing?.status === "evicted" && !opts.manual;
    const willBuild = approved && !evictedAndUnasked && !syncOnly;
    if (existing) {
      await getDb()
        .update(appPreviewsTable)
        .set({
          prTitle: pr.title,
          prAuthor: pr.author,
          prUrl: pr.url,
          headBranch: pr.headBranch,
          headSha: pr.headSha,
          headRepo: pr.headRepo,
          headCloneUrl: pr.headCloneUrl,
          baseBranch: pr.baseBranch,
          isFork: pr.isFork,
          ...(syncOnly ? {} : { state: "open", closedAt: null }),
          ...(approved
            ? existing.approvedSha === pr.headSha
              ? {}
              : { approvedAt: now, approvedSha: pr.headSha }
            : { status: "blocked" }),
          lastActivityAt: now,
          updatedAt: now,
        })
        .where(eq(appPreviewsTable.id, existing.id));
      if (!approved && hasStack(existing)) {
        await stopPreview(existing, "blocked");
      }
    } else {
      const server =
        (await getServerById(settings.serverId ?? app.serverId)) ?? undefined;
      const { host, certProvider } = previewHost({
        appId,
        slug: app.slug,
        prNumber: pr.number,
        baseDomain: settings.baseDomain,
        https: settings.https,
        ip: resolveServerIp(server),
      });
      previewId = newId("prv");
      await getDb()
        .insert(appPreviewsTable)
        .values({
          id: previewId,
          appId,
          prNumber: pr.number,
          prTitle: pr.title,
          prAuthor: pr.author,
          prUrl: pr.url,
          headBranch: pr.headBranch,
          headSha: pr.headSha,
          headRepo: pr.headRepo,
          headCloneUrl: pr.headCloneUrl,
          baseBranch: pr.baseBranch,
          isFork: pr.isFork,
          approvedAt: approved ? now : null,
          approvedSha: approved ? pr.headSha : null,
          deployKey: previewDeployKey(app.slug, pr.number),
          host,
          certProvider,
          port: settings.port,
          status: approved ? "queued" : "blocked",
          state: "open",
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        });
    }

    if (willBuild)
      await withKeyedLock(`preview-cap:${appId}`, () =>
        evictToFit(appId, settings.maxActive + 1, settings.maxActive),
      );

    publishAppChanged(appId);
    if (!approved) {
      return {
        previewId,
        deploymentId: null,
        refusal: { kind: "awaiting-approval" },
      };
    }
    if (evictedAndUnasked) {
      return {
        previewId,
        deploymentId: null,
        refusal: { kind: "evicted", max: settings.maxActive },
      };
    }
    if (syncOnly) return { previewId, deploymentId: null };
    const deploymentId = await deployPreviewRow(previewId!, {
      actor: opts.actor,
      actorProvider: opts.actorProvider,
      commitMessage: pr.title,
    });
    return { previewId, deploymentId };
  });
}

async function loadPreviewRow(
  appId: string,
  prNumber: number,
): Promise<typeof appPreviewsTable.$inferSelect | null> {
  const rows = await getDb()
    .select()
    .from(appPreviewsTable)
    .where(
      and(
        eq(appPreviewsTable.appId, appId),
        eq(appPreviewsTable.prNumber, prNumber),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
