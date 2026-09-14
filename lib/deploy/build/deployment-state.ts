import "server-only";

import { and, eq, inArray, ne, notInArray } from "drizzle-orm";
import { completePendingAppMigration } from "../../data/app-migration";
import { appendLog, finalizeDeploymentLogs } from "../../data/deployment-logs";
import { sweepSupersededAppImages } from "../../data/docker-cleanup/deploy-sweep";
import { getDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  deployments as deploymentsTable,
  appPreviews as appPreviewsTable,
} from "../../db/schema/control-plane/deployments";
import { publishAppChanged } from "../../graphql/pubsub";
import { nowIso } from "../../ids";
import { dispatchAlert } from "../../notify/dispatch";
import type { Deployment, LogLine } from "../../types/deployment";
import { formatBytes } from "../../utils";
import { syncPreviewComment } from "../preview-comment";
import { destroyStack } from "./stack-lifecycle";

// log enqueues one build-log line into the buffered writer (fire-and-forget).
export function log(
  depId: string,
  level: LogLine["level"],
  text: string,
): void {
  appendLog(depId, { ts: nowIso(), level, text });
}

// settleMove finishes a pending server move once this deploy is up on the new host.
export async function settleMove(
  depId: string,
  appId: string,
  serverId: string,
): Promise<void> {
  const outcome = await completePendingAppMigration(
    appId,
    serverId,
    (level, text) => log(depId, level, text),
  ).catch((e) => {
    log(
      depId,
      "warn",
      `data migration step failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    return "nothing" as const;
  });
  if (outcome === "rolled-back" || outcome === "held")
    await setDep(depId, { status: "error" });
}

// setDep patches a deployment row.
export async function setDep(
  depId: string,
  patch: Partial<Deployment>,
  opts: { onlyIfNotCanceled?: boolean } = {},
): Promise<boolean> {
  const set: Record<string, unknown> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.environment !== undefined) set.environment = patch.environment;
  if (patch.commitSha !== undefined) set.commitSha = patch.commitSha;
  if (patch.commitMessage !== undefined)
    set.commitMessage = patch.commitMessage;
  if (patch.commitAuthor !== undefined) set.commitAuthor = patch.commitAuthor;
  if (patch.branch !== undefined) set.branch = patch.branch;
  if (patch.url !== undefined) set.url = patch.url;
  if (patch.startedAt !== undefined) set.startedAt = patch.startedAt;
  if (patch.readyAt !== undefined) set.readyAt = patch.readyAt;
  if (patch.buildDurationMs !== undefined)
    set.buildDurationMs = patch.buildDurationMs;
  if (patch.imageRef !== undefined) set.imageRef = patch.imageRef;
  if (patch.buildServerId !== undefined)
    set.buildServerId = patch.buildServerId;
  const rows = await getDb()
    .update(deploymentsTable)
    .set(set)
    .where(
      opts.onlyIfNotCanceled
        ? and(
            eq(deploymentsTable.id, depId),
            ne(deploymentsTable.status, "canceled"),
          )
        : eq(deploymentsTable.id, depId),
    )
    .returning({ appId: deploymentsTable.appId });
  // A deployment's status feeds the app's `latestDeployment` view, so push the
  // owning app to live subscribers when it changes.
  const appId = rows[0]?.appId;
  if (appId && "status" in patch) publishAppChanged(appId);
  return rows.length > 0;
}

// DeployTarget is what a running deploy writes its LIVE state onto.
export type DeployTarget = {
  appId: string;
  // Alert routing. The runner is detached and has no request identity, which is why
  // the team rides along rather than being resolved at dispatch time.
  teamId: string;
  name: string;
  slug: string;
} & (
  | { kind: "app" }
  | { kind: "preview"; previewId: string; prNumber: number; deployKey: string }
);

// targetFor names the target a deployment row belongs to. `preview_id` is the whole test.
export function targetFor(
  dep: Pick<Deployment, "appId" | "previewId" | "prNumber" | "deployKey">,
  app: { teamId: string; name: string; slug: string },
): DeployTarget {
  const common = {
    appId: dep.appId,
    teamId: app.teamId,
    name: app.name,
    slug: app.slug,
  };
  return dep.previewId
    ? {
        ...common,
        kind: "preview",
        previewId: dep.previewId,
        prNumber: dep.prNumber ?? 0,
        deployKey: dep.deployKey || app.slug,
      }
    : { ...common, kind: "app" };
}

// settlePreviewDeployState writes a preview's deploy state, but only while the preview
// still WANTS a stack - evicted or closed mid-build, the stack comes straight back down.
export async function settlePreviewDeployState(
  previewId: string,
  deployKey: string,
  status: string | undefined,
): Promise<boolean> {
  const rows = await getDb()
    .update(appPreviewsTable)
    .set({
      ...(status === undefined ? {} : { status }),
      // The stack is about to exist again: from here on a teardown is owed.
      ...(status === "building" ? { tornDownAt: null } : {}),
      lastActivityAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(appPreviewsTable.id, previewId),
        eq(appPreviewsTable.state, "open"),
        notInArray(appPreviewsTable.status, ["evicted", "blocked"]),
      ),
    )
    .returning({ id: appPreviewsTable.id });
  if (rows.length > 0) return true;
  if (status === "active" || status === "error") {
    const gone = await destroyStack(deployKey, { removeVolumes: true })
      .then(() => true)
      .catch(() => false);
    if (gone) {
      await getDb()
        .update(appPreviewsTable)
        .set({ tornDownAt: nowIso(), updatedAt: nowIso() })
        .where(eq(appPreviewsTable.id, previewId));
    }
  }
  return false;
}

// setDeployState patches the deploy's owner. `status` is the only key both owners understand.
export async function setDeployState(
  target: DeployTarget,
  patch: Partial<typeof appsTable.$inferInsert>,
): Promise<boolean> {
  if (target.kind === "preview") {
    const kept = await settlePreviewDeployState(
      target.previewId,
      target.deployKey,
      patch.status ?? undefined,
    );
    publishAppChanged(target.appId);
    return kept;
  } else {
    await getDb()
      .update(appsTable)
      .set({ ...patch, updatedAt: nowIso() })
      .where(eq(appsTable.id, target.appId));
  }
  publishAppChanged(target.appId);
  return true;
}

async function markStopped(depId: string, target: DeployTarget): Promise<void> {
  log(
    depId,
    "warn",
    "Build stopped by user - result discarded. A build already running on the host may finish in the background; its output is not deployed.",
  );
  // Settle ONLY if this canceled deploy is still its owner's current one.
  const settled =
    target.kind === "preview"
      ? await getDb()
          .update(appPreviewsTable)
          .set({ status: "idle", updatedAt: nowIso() })
          .where(
            and(
              eq(appPreviewsTable.id, target.previewId),
              eq(appPreviewsTable.latestDeploymentId, depId),
            ),
          )
          .returning({ id: appPreviewsTable.id })
      : await getDb()
          .update(appsTable)
          .set({ status: "idle", updatedAt: nowIso() })
          .where(
            and(
              eq(appsTable.id, target.appId),
              eq(appsTable.latestDeploymentId, depId),
            ),
          )
          .returning({ id: appsTable.id });
  if (settled.length > 0) publishAppChanged(target.appId);
}

// commitOutcome atomically writes a deployment's terminal outcome UNLESS a "Stop build"
// already claimed the row.
export async function commitOutcome(
  depId: string,
  target: DeployTarget,
  depPatch: Partial<Deployment>,
  appPatch: Partial<typeof appsTable.$inferInsert>,
  opts: { rollback?: boolean } = {},
): Promise<boolean> {
  if (!(await setDep(depId, depPatch, { onlyIfNotCanceled: true }))) {
    await markStopped(depId, target);
    // No alert: a cancel is somebody pressing "Stop build", and they know.
    return false;
  }
  const ok = depPatch.status === "ready";
  await setDeployState(
    target,
    ok && target.kind !== "preview"
      ? { ...appPatch, pendingChangesAt: null }
      : appPatch,
  );
  const what =
    target.kind === "preview"
      ? `${target.name} #${target.prNumber}`
      : target.name;
  dispatchAlert({
    teamId: target.teamId,
    key: ok ? "deployment_succeeded" : "deployment_failed",
    // A rollback is not "a new version": saying so to a channel would tell the team
    // something shipped forward at the exact moment somebody undid it.
    title: `${what} ${ok ? (opts.rollback ? "rolled back" : "deployed") : "failed to deploy"}`,
    body: ok
      ? opts.rollback
        ? "An earlier version is live again."
        : "The new version is live."
      : "The build log has the error that stopped it.",
    path:
      target.kind === "preview"
        ? `/apps/${target.slug}/pull-requests`
        : `/apps/${target.slug}`,
  });
  // Tell the pull request how its preview ended. Fire-and-forget by contract: a GitHub
  // failure must never fail a deploy that already succeeded.
  if (target.kind === "preview" && depPatch.status) {
    const kind =
      depPatch.status === "ready"
        ? ("ready" as const)
        : depPatch.status === "error"
          ? ("failed" as const)
          : null;
    if (kind) void syncPreviewComment(target.previewId, { kind });
  }
  return true;
}

// sweepAfterDeploy drops the superseded images beyond the policy's keep-count on this
// deploy's server NOW, not at the next nightly sweep.
export async function sweepAfterDeploy(
  depId: string,
  serverId: string,
): Promise<void> {
  const freed = await sweepSupersededAppImages(serverId);
  if (freed > 0) {
    log(
      depId,
      "info",
      `Reclaimed ${formatBytes(freed)} of superseded images and build cache`,
    );
  }
}

// settleIfCanceled is the read-only cancel check for the pre-build window; the terminal
// sites use `commitOutcome` (an atomic CAS) instead.
export async function settleIfCanceled(
  depId: string,
  target: DeployTarget,
): Promise<boolean> {
  const rows = await getDb()
    .select({ status: deploymentsTable.status })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.id, depId))
    .limit(1);
  if (rows[0]?.status !== "canceled") return false;
  await markStopped(depId, target);
  return true;
}

// isInFlightStatus says whether a deployment status is non-terminal - a build was in flight.
export function isInFlightStatus(s: Deployment["status"]): boolean {
  return s === "queued" || s === "building";
}

// reconcileInFlightDeployments reconciles deployments orphaned by a control-plane restart.
export async function reconcileInFlightDeployments(): Promise<number> {
  const db = getDb();
  const orphaned = await db
    .select({
      id: deploymentsTable.id,
      appId: deploymentsTable.appId,
      teamId: appsTable.teamId,
    })
    .from(deploymentsTable)
    .innerJoin(appsTable, eq(appsTable.id, deploymentsTable.appId))
    .where(eq(deploymentsTable.status, "building"));
  if (orphaned.length > 0) {
    const affectedApps = new Set(orphaned.map((d) => d.appId));
    await db
      .update(deploymentsTable)
      .set({ status: "error" })
      .where(eq(deploymentsTable.status, "building"));
    for (const dep of orphaned) {
      log(
        dep.id,
        "error",
        "Deployment interrupted by a control-plane restart and marked failed.",
      );
    }
    await Promise.all(orphaned.map((d) => finalizeDeploymentLogs(d.id)));
    await db
      .update(appsTable)
      .set({ status: "error", updatedAt: nowIso() })
      .where(
        and(
          inArray(appsTable.id, [...affectedApps]),
          eq(appsTable.status, "building"),
        ),
      );
    for (const appId of affectedApps) publishAppChanged(appId);
    // One alert per team, not one per deployment: this is a bulk flip that bypasses
    // commitOutcome entirely, and a restart must not fan out N alerts.
    const perTeam = new Map<string, number>();
    for (const d of orphaned)
      perTeam.set(d.teamId, (perTeam.get(d.teamId) ?? 0) + 1);
    for (const [teamId, n] of perTeam)
      dispatchAlert({
        teamId,
        key: "deployment_interrupted",
        title: `${n} deployment${n > 1 ? "s were" : " was"} interrupted`,
        body: "Deplo restarted while they were building. Redeploy when ready.",
        path: "/deployments",
      });
    console.warn(
      `[deplo] reconciled ${orphaned.length} interrupted deployment(s) to error on startup`,
    );
  }
  // QUEUED deploys are DURABLE across a restart: no build ever started.
  return orphaned.length;
}
