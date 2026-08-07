import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import {
  apps as appsTable,
  appPreviews as appPreviewsTable,
  githubInstallation as githubInstallationTable,
} from "../db/schema/control-plane";
import {
  parsePullRequestEvent,
  previewIntent,
  type RawPullRequestPayload,
} from "../deploy/pr-webhook";
import {
  closePreview,
  openOrSyncPreview,
  refusalMessage,
} from "../deploy/preview-lifecycle";
import { syncPreviewComment } from "../deploy/preview-comment";

/**
 * The `pull_request` arm of the GitHub webhook — the twin of the `push` arm in
 * [the route](../../app/api/github/webhook/route.ts), and shaped the same way.
 *
 * RUNS WITH NO SESSION. Every function it calls must be session-free: a
 * `requireCapability` in this path would throw on every delivery and drop it
 * silently. That is why the lifecycle module is deliberately ungated and the
 * gated surface (`lib/data/previews.ts`) is a separate layer.
 *
 * Always answers 200. A delivery Deplo cannot act on is acknowledged, and the
 * reason is logged — that log line is the only debugging surface an operator
 * gets when previews "just don't happen".
 */
export async function handlePullRequestDelivery(raw: string): Promise<Response> {
  let payload: RawPullRequestPayload;
  try {
    payload = JSON.parse(raw) as RawPullRequestPayload;
  } catch {
    return new Response("bad payload", { status: 400 });
  }

  const ev = parsePullRequestEvent(payload);
  const numericInstall = payload.installation?.id;
  if (!ev || !numericInstall) {
    console.warn(
      `[github-webhook] pull_request ignored: repo=${payload.repository?.full_name ?? "?"} ` +
        `install=${numericInstall ?? "?"} action=${payload.action ?? "?"}`,
    );
    return new Response("ok", { status: 200 });
  }

  const installRows = await getDb()
    .select()
    .from(githubInstallationTable)
    .where(eq(githubInstallationTable.installationId, numericInstall))
    .limit(1);
  const install = installRows[0];
  if (!install) {
    console.warn(
      `[github-webhook] no installation row for numeric id ${numericInstall} (repo=${ev.baseRepo})`,
    );
    return new Response("ok", { status: 200 });
  }

  // Same cut as the push arm: github-source apps of this installation. NOT
  // filtered on `auto_deploy` — a user who turned off deploy-on-push did it to
  // control production releases, and coupling previews to that switch
  // manufactures exactly the "why don't previews work" confusion this feature
  // must not have. Previews have their own switch.
  const candidates = (
    await getDb()
      .select()
      .from(appsTable)
      .where(
        and(
          eq(appsTable.source, "github"),
          eq(appsTable.repoInstallationId, install.id),
        ),
      )
  ).filter((a) => a.repoRepo === ev.baseRepo);

  if (candidates.length === 0) {
    console.warn(
      `[github-webhook] pull_request #${ev.number} on ${ev.baseRepo}: no app deploys this repo ` +
        `(install=${install.id})`,
    );
    return new Response("ok", { status: 200 });
  }

  for (const app of candidates) {
    try {
      const intent = previewIntent(
        {
          branch: app.repoBranch || "main",
          previewsEnabled: app.previewEnabled,
        },
        ev,
      );

      if (intent.kind === "destroy") {
        const existing = await getDb()
          .select({ id: appPreviewsTable.id })
          .from(appPreviewsTable)
          .where(
            and(
              eq(appPreviewsTable.appId, app.id),
              eq(appPreviewsTable.prNumber, ev.number),
            ),
          )
          .limit(1);
        if (existing[0]) {
          await closePreview(
            existing[0].id,
            ev.merged ? "pull request merged" : "pull request closed",
          );
          void syncPreviewComment(existing[0].id, { kind: "destroyed" });
        }
        continue;
      }

      if (intent.kind === "ignore") {
        console.warn(
          `[github-webhook] pull_request #${ev.number} on ${ev.baseRepo} skipped for ${app.slug}: ` +
            `${intent.reason} (action=${ev.action} base=${ev.baseBranch} tracked=${app.repoBranch || "main"} ` +
            `previews=${app.previewEnabled})`,
        );
        continue;
      }

      const res = await openOrSyncPreview(
        app.id,
        {
          number: ev.number,
          title: ev.title,
          author: ev.author,
          url: ev.url,
          headBranch: ev.headBranch,
          headSha: ev.headSha,
          headRepo: ev.headRepo,
          headCloneUrl: ev.headCloneUrl,
          baseBranch: ev.baseBranch,
          isFork: ev.isFork,
        },
        { actor: ev.author || "github" },
      );

      // Tell the pull request what happened, whatever happened. A refusal that
      // leaves no trace is the worst outcome: the contributor waits for a
      // preview that was never going to come.
      if (res.previewId && res.refusal?.kind === "awaiting-approval") {
        void syncPreviewComment(res.previewId, { kind: "awaiting-approval" });
      } else if (res.previewId && !res.refusal) {
        void syncPreviewComment(res.previewId, { kind: "building" });
      } else if (res.refusal && res.refusal.kind !== "previews-off") {
        console.warn(
          `[github-webhook] pull_request #${ev.number} on ${ev.baseRepo} refused for ${app.slug}: ` +
            refusalMessage(res.refusal),
        );
      }
    } catch (e) {
      // One app's failure must never block the rest of the fan-out.
      console.warn(
        `[github-webhook] pull_request #${ev.number} failed for ${app.slug}: ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  return new Response("ok", { status: 200 });
}
