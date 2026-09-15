import "server-only";

import { BACKUP_RUN_MAX_MS } from "../../infra/agent-client/deadlines";
import { preloadSummaries, type SummaryPreload } from "../app-graph-load";
import type { App, AppStatus } from "../../types/app";
import type { Deployment } from "../../types/deployment";
import type { Capability } from "../../types/identity";

const STOPPING_STALE_MS = 90_000;

const RESTORING_STALE_MS = BACKUP_RUN_MAX_MS;

export interface AppSummary extends App {
  latestDeployment: Deployment | null;
  domainCount: number;

  capabilities?: Capability[];
}

export function reconcileStatus(
  status: AppStatus,
  updatedAt: string,
  now: number = Date.now(),
): AppStatus {
  const age = now - new Date(updatedAt).getTime();
  if (status === "stopping")
    return age > STOPPING_STALE_MS ? "idle" : "stopping";
  if (status === "restoring")
    return age > RESTORING_STALE_MS ? "error" : "restoring";
  return status;
}

export function summarize(p: App, pre: SummaryPreload): AppSummary {
  const status = reconcileStatus(p.status, p.updatedAt);
  return {
    ...p,
    status,
    logo: p.logo ?? null,
    folderId: p.folderId ?? null,
    latestDeployment: p.latestDeploymentId
      ? (pre.latestDeployments.get(p.latestDeploymentId) ?? null)
      : null,
    domainCount: pre.domainCounts.get(p.id) ?? 0,
  };
}

export async function summarizeOne(p: App): Promise<AppSummary> {
  const pre = await preloadSummaries([p]);
  return summarize(p, pre);
}
