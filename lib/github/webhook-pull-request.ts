import "server-only";

import { and, eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { appPreviews as appPreviewsTable } from "../db/schema/control-plane/deployments";
import { githubInstallation as githubInstallationTable } from "../db/schema/control-plane/integrations";
import {
  parsePullRequestEvent,
  previewIntent,
  type RawPullRequestPayload,
} from "../deploy/pr-webhook";
import { closePreview } from "../deploy/preview-lifecycle/close";
import { refusalMessage } from "../deploy/preview-lifecycle/fork-guard";
import { openOrSyncPreview } from "../deploy/preview-lifecycle/open-sync";
import { syncPreviewComment } from "../deploy/preview-comment";
import { parseRequiredLabels } from "../deploy/preview-lifecycle/settings";

export async function handlePullRequestDelivery(
  raw: string,
  appId: string,
): Promise<Response> {
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
    .where(
      and(
        eq(githubInstallationTable.installationId, numericInstall),
        eq(githubInstallationTable.appId, appId),
      ),
    )
    .limit(1);
  const install = installRows[0];
  if (!install) {
    console.warn(
      `[github-webhook] no installation row for numeric id ${numericInstall} on app=${appId} (repo=${ev.baseRepo})`,
    );
    return new Response("ok", { status: 200 });
  }

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
          autoDeploy: app.previewAutoDeploy,
          buildDrafts: app.previewBuildDrafts,
          requiredLabels: parseRequiredLabels(app.previewRequiredLabels),
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
        {
          actor: ev.author || "github",
          actorProvider: "github",
          build: intent.kind === "deploy",
        },
      );

      if (res.previewId && res.refusal?.kind === "awaiting-approval") {
        void syncPreviewComment(res.previewId, { kind: "awaiting-approval" });
      } else if (res.previewId && res.refusal?.kind === "evicted") {
        void syncPreviewComment(res.previewId, res.refusal);
      } else if (res.previewId && !res.refusal && intent.kind === "deploy") {
        void syncPreviewComment(res.previewId, { kind: "building" });
      } else if (res.refusal && res.refusal.kind !== "previews-off") {
        console.warn(
          `[github-webhook] pull_request #${ev.number} on ${ev.baseRepo} refused for ${app.slug}: ` +
            refusalMessage(res.refusal),
        );
      }
    } catch (e) {
      console.warn(
        `[github-webhook] pull_request #${ev.number} failed for ${app.slug}: ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  return new Response("ok", { status: 200 });
}
