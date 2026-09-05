import "server-only";

import { eq, isNull, and } from "drizzle-orm";

import { loadAppGraph } from "../data/app-graph-load";
import { teamSlugById } from "../data/teams";
import { getDb } from "../db/client";
import {
  apps as appsTable,
  appPreviews as appPreviewsTable,
} from "../db/schema/control-plane";
import { TransientGithubError, upsertPullRequestComment } from "../github/app";
import { githubFullName } from "../github/repo-id";
import { PUBLIC_URL_PLACEHOLDER, resolveManifestBaseUrl } from "../public-url";
import { withTeam } from "../team-path";

/**
 * The ONE comment Deplo keeps on a pull request, edited in place. A pull request
 * with twenty pushes must still have one Deplo comment, not twenty, so the
 * comment id is stored on the preview row and every later transition is a `PATCH`.
 */

const MARKER = "<!-- deplo-preview -->";

export type PreviewCommentState =
  | { kind: "building" }
  | { kind: "ready" }
  | { kind: "failed" }
  | { kind: "destroyed" }
  | { kind: "awaiting-approval" }
  /** Stopped by the app's own limit; the pull request is still open. */
  | { kind: "evicted"; max: number }
  | { kind: "refused"; reason: string };

/** The comment body for one state. Markdown, no emoji, no ellipsis. */
export function previewCommentBody(input: {
  state: PreviewCommentState;
  url: string;
  host: string;
  buildLogUrl: string | null;
}): string {
  const link = input.url ? `[${input.host}](${input.url})` : "Not deployed";
  const row = (status: string, preview: string): string =>
    [
      "| Status | Preview |",
      "| --- | --- |",
      `| ${status} | ${preview} |`,
    ].join("\n");

  let table: string;
  let note = "";
  switch (input.state.kind) {
    case "building":
      table = row("Building", "Waiting for the build");
      break;
    case "ready":
      table = row("Ready", link);
      break;
    case "failed":
      table = row("Failed", "Not deployed");
      break;
    case "destroyed":
      table = row("Torn down", "Not deployed");
      note = "The preview for this pull request has been removed.";
      break;
    case "awaiting-approval":
      table = row("Waiting for approval", "Not deployed");
      note =
        "This pull request comes from a fork, so a maintainer has to approve it in Deplo before a preview is built.";
      break;
    case "evicted":
      table = row("Stopped", "Not deployed");
      note = `Stopped to stay within the app's limit of ${input.state.max} live previews. Redeploy it from Deplo to bring the same address back.`;
      break;
    case "refused":
      table = row("Not built", "Not deployed");
      note = input.state.reason;
      break;
  }

  const parts = [MARKER, "### Deplo preview", "", table];
  if (note) parts.push("", note);
  // A link to `https://your-deplo-host` is worse than no link at all.
  if (input.buildLogUrl) parts.push("", `[Build logs](${input.buildLogUrl})`);
  return parts.join("\n") + "\n";
}

/** The pauses between attempts at GitHub: a 502 is usually over in seconds. */
export const COMMENT_RETRY_DELAYS_MS = [2_000, 6_000, 15_000];

/**
 * Run `fn`, asking again after each delay while it fails with a transient error.
 * Anything else propagates at once. The caller is fire-and-forget, so the wait
 * costs nobody anything; without it a GitHub hiccup left "Building" on a pull
 * request whose preview had been ready for hours.
 */
export async function retryTransient<T>(
  fn: () => Promise<T>,
  delays: readonly number[],
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof TransientGithubError) || attempt >= delays.length)
        throw e;
      await sleep(delays[attempt]!);
    }
  }
}

let disabledForTest = false;

/** Test-only: the callers fire this and forget it, and a stray query landing in
 *  the next test's pglite transaction is a hang, not a failure. */
export function __disablePreviewCommentsForTest(): void {
  disabledForTest = true;
}

/**
 * Push the current state of a preview onto its pull request.
 */
export async function syncPreviewComment(
  previewId: string,
  state: PreviewCommentState,
): Promise<void> {
  if (disabledForTest) return;
  try {
    const rows = await getDb()
      .select()
      .from(appPreviewsTable)
      .where(eq(appPreviewsTable.id, previewId))
      .limit(1);
    const p = rows[0];
    if (!p) return;
    // The app can turn the comment off. One guard here covers every caller: the deploy
    // outcome, the open, the sync and the teardown.
    const wanted = await getDb()
      .select({ comment: appsTable.previewComment })
      .from(appsTable)
      .where(eq(appsTable.id, p.appId))
      .limit(1);
    if (!wanted[0]?.comment) return;
    const app = await loadAppGraph(p.appId);
    const installationId = app?.repo?.installationId;
    const fullName = app?.repo ? githubFullName(app.repo) : null;
    if (!app || !installationId || !fullName) return;

    const base = resolveManifestBaseUrl();
    const buildLogUrl =
      base && base !== PUBLIC_URL_PLACEHOLDER && p.latestDeploymentId
        ? base +
          withTeam(
            `/apps/${app.slug}/deployments/${p.latestDeploymentId}`,
            await teamSlugById(app.teamId),
          )
        : null;

    const body = previewCommentBody({
      state,
      url: p.url,
      host: p.host,
      buildLogUrl,
    });
    const commentId = await retryTransient(
      () =>
        upsertPullRequestComment({
          installationId,
          fullName,
          prNumber: p.prNumber,
          commentId: p.commentId,
          body,
        }),
      COMMENT_RETRY_DELAYS_MS,
    );
    // Compare-and-set: two rapid `synchronize` deliveries must not both post.
    // A loser simply keeps the winner's id and PATCHes it next time.
    if (commentId && commentId !== p.commentId) {
      await getDb()
        .update(appPreviewsTable)
        .set({ commentId })
        .where(
          and(
            eq(appPreviewsTable.id, previewId),
            isNull(appPreviewsTable.commentId),
          ),
        );
    }
  } catch (e) {
    console.warn(
      `[deplo-pr-comment] ${previewId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
