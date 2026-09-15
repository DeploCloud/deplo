import "server-only";

import { eq, isNull, and } from "drizzle-orm";

import { loadAppGraph } from "../data/app-graph-load";
import { teamSlugById } from "../data/teams";
import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { appPreviews as appPreviewsTable } from "../db/schema/control-plane/deployments";
import { TransientGithubError, upsertPullRequestComment } from "../github/app";
import { githubFullName } from "../github/repo-id";
import { PUBLIC_URL_PLACEHOLDER, resolveManifestBaseUrl } from "../public-url";
import { withTeam } from "../team-path";

const MARKER = "<!-- deplo-preview -->";

export type PreviewCommentState =
  | { kind: "building" }
  | { kind: "ready" }
  | { kind: "failed" }
  | { kind: "destroyed" }
  | { kind: "awaiting-approval" }
  | { kind: "evicted"; max: number }
  | { kind: "refused"; reason: string };

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
  if (input.buildLogUrl) parts.push("", `[Build logs](${input.buildLogUrl})`);
  return parts.join("\n") + "\n";
}

export const COMMENT_RETRY_DELAYS_MS = [2_000, 6_000, 15_000];

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

export function __disablePreviewCommentsForTest(): void {
  disabledForTest = true;
}

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
