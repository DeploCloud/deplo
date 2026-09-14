import "server-only";

// https://deplo.build/docs/guides/networking/pull-request-previews

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

// The pull request facts a preview is created or refreshed from.
export interface PullRequestFacts {
  number: number;
  title: string;
  author: string;
  url: string;
  headBranch: string;
  headSha: string;
  // `owner/name` of the head repo; differs from the app's repo ⇒ a fork.
  headRepo: string;
  // The fork's own clone URL - a fork's head ref does not exist on the base.
  headCloneUrl: string;
  baseBranch: string;
  isFork: boolean;
}

export interface OpenOrSyncResult {
  previewId: string | null;
  deploymentId: string | null;
  refusal?: PreviewRefusal;
}

// Open (or refresh) the preview for one pull request and start its build. The URL is
// already commented on the pull request, so regenerating the host on every push would
// strand the link somebody is testing.
export async function openOrSyncPreview(
  appId: string,
  pr: PullRequestFacts,
  opts: {
    actor: string;
    // The git host `actor` is a login on, when a webhook opened this.
    actorProvider?: string | null;
    // A manual deploy approves a fork implicitly.
    approve?: boolean;
    // A person asked for this build, rather than a webhook delivering a push. The
    // only thing it changes: a manual deploy REVIVES an evicted preview (that is
    // what the Redeploy button is for), a webhook never does.
    manual?: boolean;
    // `false` ⇒ record the pull request's new facts and build nothing: a push on a
    // manual-only app, a title edit. Never creates a row and never reopens one.
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
    // A fork's code is attacker-authored and would run on the operator's host.
    // `deny` never records it at all; `approve` records it so the pull request is
    // VISIBLE in the list with an approve button, but builds nothing.
    if (pr.isFork && policy === "deny" && !opts.approve) {
      return {
        previewId: null,
        deploymentId: null,
        refusal: { kind: "fork-denied" },
      };
    }
    // A stranger's code with the app's host reach (a Bind, a privileged compose)
    // would run on the server with it: refused whatever the policy or approval.
    if (pr.isFork) {
      const refusal = await forkRefusal(appId);
      if (refusal)
        return { previewId: existing?.id ?? null, deploymentId: null, refusal };
    }
    // Per COMMIT, not per pull request.
    const approved =
      !pr.isFork ||
      policy === "allow" ||
      opts.approve ||
      (Boolean(existing?.approvedSha) && existing?.approvedSha === pr.headSha);

    const now = nowIso();
    let previewId = existing?.id ?? null;
    // An evicted preview keeps taking pull request updates - its title, head SHA and
    // state stay honest in the list, but a push does NOT rebuild it.
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
          // Reopening a closed pull request revives the same preview, key and
          // host included, so the old link starts working again. A facts-only
          // sync reopens nothing: a title edit can arrive for a closed one.
          ...(syncOnly ? {} : { state: "open", closedAt: null }),
          // `torn_down_at` is the proof a stack is gone, and it stays until the
          // build actually STARTS (`settlePreviewDeployState`): a reopen evicted
          // before its build has nothing on any host, and asking the agent to
          // tear down a stack that has no file fails every hour, forever.
          // Re-stamped whenever a NEW head is approved, not only the first time:
          // with a per-commit rule a stale `approved_sha` would refuse the very
          // build the caller just approved, and then refuse every one after it.
          ...(approved
            ? existing.approvedSha === pr.headSha
              ? {}
              : { approvedAt: now, approvedSha: pr.headSha }
            : { status: "blocked" }),
          lastActivityAt: now,
          updatedAt: now,
        })
        .where(eq(appPreviewsTable.id, existing.id));
      // An unreviewed commit on a fork whose reviewed commit is still RUNNING: the
      // stack serves code the pull request no longer contains, and a `blocked` row
      // holds no slot, so leaving it up would also put the app over its own limit.
      if (!approved && hasStack(existing)) {
        await stopPreview(existing, "blocked");
      }
    } else {
      // At the cap, the NEW preview wins and the least recently active one is torn
      // down - settled below, under the per-app lock, once the row exists.
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
          // Frozen here, like the host and the deploy key: the renderer reads the
          // preview ROW, and changing the app's setting must not silently repoint
          // a preview somebody is already testing.
          port: settings.port,
          status: approved ? "queued" : "blocked",
          state: "open",
          lastActivityAt: now,
          createdAt: now,
          updatedAt: now,
        });
    }

    // The cap has to be settled PER APP, not per pull request: this function's lock is
    // keyed `appId:prNumber`, so two PRs opened together took DIFFERENT locks, both
    // read the same under-cap count above, and neither evicted.
    if (willBuild)
      await withKeyedLock(`preview-cap:${appId}`, () =>
        // `+ 1` because evictToFit makes room FOR a preview about to be inserted (it evicts
        // `count - keep + 1`).
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
