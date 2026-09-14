import "server-only";

import { BACKUP_RUN_MAX_MS } from "../../infra/agent-client/deadlines";
import { preloadSummaries, type SummaryPreload } from "../app-graph-load";
import type { App, AppStatus } from "../../types/app";
import type { Deployment } from "../../types/deployment";
import type { Capability } from "../../types/identity";

// "stopping" is transient: a crash mid-stop would wedge it forever, so a stale one reads as "idle".
const STOPPING_STALE_MS = 90_000;

// A half-restored app heals to "error", not "idle" - it is broken, not stopped on purpose.
const RESTORING_STALE_MS = BACKUP_RUN_MAX_MS;

export interface AppSummary extends App {
  latestDeployment: Deployment | null;
  domainCount: number;

  // Absent on the engine paths that summarize without a caller: "unknown", never "denied".
  capabilities?: Capability[];
}

// reconcileStatus maps a stored status to what callers see, healing a wedged transient state.
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

// summarize folds an app into an AppSummary - PURE over preloaded deployment and domain maps.
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

// summarizeOne summarizes one already-loaded app with its own bounded preload.
export async function summarizeOne(p: App): Promise<AppSummary> {
  const pre = await preloadSummaries([p]);
  return summarize(p, pre);
}
