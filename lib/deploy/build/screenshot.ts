import "server-only";

import { and, eq, or, sql } from "drizzle-orm";
import { CaptureOutcome } from "../../agent/gen/agent";
import { basicAuthCredentialForCapture } from "../../data/basic-auth";
import { instanceFrozen } from "../../data/deplo-move/freeze";
import { getDb } from "../../db/client";
import {
  appEnvironments,
  apps as appsTable,
} from "../../db/schema/control-plane/apps";
import {
  appPreviews,
  deploymentScreenshots,
  deployments,
} from "../../db/schema/control-plane/deployments";
import { publishAppChanged } from "../../graphql/pubsub";
import { nowIso } from "../../ids";
import { connectAgent } from "../../infra/agent-client/connect";
import { SCREENSHOT_CAPABILITY } from "../../infra/agent-client/hello-capabilities";

// Besides the app's production deployment, which is always kept.
export const SCREENSHOTS_KEPT = 20;
export const SCREENSHOT_RETRY_MS = 60_000;

export type CaptureResult =
  | { kind: "stored" }
  | {
      kind: "skipped";
      reason:
        | "frozen"
        | "gone"
        | "off"
        | "no-url"
        | "not-live"
        | "fork"
        | "old-agent";
    }
  | { kind: "failed"; outcome: CaptureOutcome; status: number; detail: string };

const INFLIGHT = Symbol.for("deplo.screenshot.inflight");
const g = globalThis as typeof globalThis & {
  [INFLIGHT]?: Map<string, Promise<CaptureResult>>;
};
const inflight = (g[INFLIGHT] ??= new Map());

// Two callers for one deployment (the post-deploy hook and a Retake) share one capture.
export function captureDeploymentScreenshot(
  depId: string,
): Promise<CaptureResult> {
  const running = inflight.get(depId);
  if (running) return running;
  const p = capture(depId).finally(() => inflight.delete(depId));
  inflight.set(depId, p);
  return p;
}

// After a deploy turns Ready: one more attempt a minute later, then nothing until the next deploy.
export function captureAfterReady(depId: string): void {
  void captureDeploymentScreenshot(depId)
    .catch(() => null)
    .then((first) => {
      if (first?.kind === "stored" || first?.kind === "skipped") return;
      // ponytail: lost on a restart; the next deploy takes it again.
      const t = setTimeout(() => {
        void hasScreenshot(depId)
          .then((has) => (has ? null : captureDeploymentScreenshot(depId)))
          .catch(() => null);
      }, SCREENSHOT_RETRY_MS);
      t.unref?.();
    });
}

const skipped = (
  reason: Extract<CaptureResult, { kind: "skipped" }>["reason"],
) => ({ kind: "skipped", reason }) as const;

async function capture(depId: string): Promise<CaptureResult> {
  if (await instanceFrozen()) return skipped("frozen");
  const [dep] = await getDb()
    .select({
      id: deployments.id,
      appId: deployments.appId,
      serverId: deployments.serverId,
      url: deployments.url,
      status: deployments.status,
      environment: deployments.environment,
      previewId: deployments.previewId,
      enabled: appsTable.screenshotsEnabled,
      productionUrl: appsTable.productionUrl,
    })
    .from(deployments)
    .innerJoin(appsTable, eq(appsTable.id, deployments.appId))
    .where(eq(deployments.id, depId))
    .limit(1);
  if (!dep || !dep.serverId) return skipped("gone");
  if (!dep.enabled) return skipped("off");
  // The production URL carries a path prefix the deployment's own URL does not.
  const url =
    dep.environment === "production" && dep.productionUrl
      ? dep.productionUrl
      : dep.url;
  if (!url) return skipped("no-url");
  if (dep.status !== "ready" || !(await isLiveDeployment(depId)))
    return skipped("not-live");
  const credential = await basicAuthCredentialForCapture(dep.appId);
  if (credential && dep.previewId && (await isForkPreview(dep.previewId)))
    return skipped("fork");

  const conn = await connectAgent(dep.serverId);
  try {
    const hello = await conn.hello();
    if (!hello.capabilities?.includes(SCREENSHOT_CAPABILITY))
      return skipped("old-agent");
    const res = await conn.captureScreenshot({
      url,
      basicAuthUsername: credential?.username ?? "",
      basicAuthPassword: credential?.password ?? "",
    });
    if (
      res.outcome !== CaptureOutcome.CAPTURE_OUTCOME_OK ||
      res.lightWebp.length === 0
    )
      return {
        kind: "failed",
        outcome: res.outcome,
        status: res.httpStatus,
        detail: res.detail,
      };
    if (
      !(await store(
        dep.id,
        dep.appId,
        Buffer.from(res.lightWebp),
        res.darkWebp.length > 0 ? Buffer.from(res.darkWebp) : null,
      ))
    )
      return skipped("off");
    await pruneScreenshots(dep.appId);
    publishAppChanged(dep.appId);
    return { kind: "stored" };
  } finally {
    conn.close();
  }
}

// Only the deployment a URL serves today: an older one would photograph today's site.
export async function isLiveDeployment(depId: string): Promise<boolean> {
  const [hit] = await getDb()
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        eq(deployments.id, depId),
        or(
          sql`exists (select 1 from ${appsTable} where ${appsTable.latestDeploymentId} = ${depId})`,
          sql`exists (select 1 from ${appPreviews} where ${appPreviews.latestDeploymentId} = ${depId})`,
          sql`exists (select 1 from ${appEnvironments} where ${appEnvironments.latestDeploymentId} = ${depId})`,
        ),
      ),
    )
    .limit(1);
  return Boolean(hit);
}

async function isForkPreview(previewId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ isFork: appPreviews.isFork })
    .from(appPreviews)
    .where(eq(appPreviews.id, previewId))
    .limit(1);
  return row?.isFork ?? false;
}

async function hasScreenshot(depId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ id: deploymentScreenshots.deploymentId })
    .from(deploymentScreenshots)
    .where(eq(deploymentScreenshots.deploymentId, depId))
    .limit(1);
  return Boolean(row);
}

// Re-reads the switch after writing, so a picture never outlives someone turning screenshots off.
async function store(
  depId: string,
  appId: string,
  light: Buffer,
  dark: Buffer | null,
): Promise<boolean> {
  const capturedAt = nowIso();
  await getDb()
    .insert(deploymentScreenshots)
    .values({ deploymentId: depId, light, dark, capturedAt })
    .onConflictDoUpdate({
      target: deploymentScreenshots.deploymentId,
      set: { light, dark, capturedAt },
    });
  const [app] = await getDb()
    .select({ enabled: appsTable.screenshotsEnabled })
    .from(appsTable)
    .where(eq(appsTable.id, appId))
    .limit(1);
  if (app?.enabled) return true;
  await getDb()
    .delete(deploymentScreenshots)
    .where(eq(deploymentScreenshots.deploymentId, depId));
  return false;
}

export async function pruneScreenshots(appId: string): Promise<void> {
  await getDb().execute(sql`
    delete from deployment_screenshots where deployment_id in (
      select s.deployment_id from deployment_screenshots s
      join deployments d on d.id = s.deployment_id
      where d.app_id = ${appId}
        and d.id is distinct from (select latest_deployment_id from apps where id = ${appId})
      order by d.created_at desc, d.seq desc
      offset ${SCREENSHOTS_KEPT}
    )`);
}
