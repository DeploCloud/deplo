"use client";

import { StatusBadge, StatusDot } from "@/components/shared/status-badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { displayStatus, type DisplayStatus } from "@/lib/apps/display-status";
import type { AppStatus } from "@/lib/types";
import type { AppRuntimeView } from "@/components/apps/use-app-runtime";
import type { OverviewRuntimeView } from "../apps-grid/overview-state";

type StatusRuntime = AppRuntimeView | OverviewRuntimeView;

export function detailFor(runtime: StatusRuntime | null): string | null {
  if (!runtime || runtime.unreachable) return null;

  if (runtime.restarting > 0) {
    const restarts = maxRestartCount(runtime);
    const times = restarts > 0 ? ` It has restarted ${restarts} times.` : "";
    return `Docker keeps restarting this container: it starts, dies, and starts again.${times} The Logs tab shows why.`;
  }
  if (runtime.total === 0)
    return "This app is deployed, but it has no container on its server at all.";
  if (runtime.running === 0)
    return "This app is deployed, but no container is running on the host. The Logs tab shows its last output.";
  if (runtime.unhealthy > 0) {
    const sick = unhealthyContainerNames(runtime);
    return `Everything is running, but ${sick.join(", ") || "a container"} is failing its healthcheck - up, but not working.`;
  }
  return null;
}

function maxRestartCount(runtime: StatusRuntime): number {
  return "maxRestartCount" in runtime
    ? runtime.maxRestartCount
    : Math.max(...runtime.containers.map((c) => c.restartCount), 0);
}

function unhealthyContainerNames(runtime: StatusRuntime): string[] {
  return "unhealthyContainers" in runtime
    ? runtime.unhealthyContainers
    : runtime.containers
        .filter((c) => c.health === "unhealthy")
        .map((c) => c.service);
}

export function StatusIndicator({
  status,
  detail,
  badge,
}: {
  status: DisplayStatus;
  detail: string | null;
  badge: boolean;
}) {
  const indicator = badge ? (
    <StatusBadge status={status} tinted labels={{ active: "Online" }} />
  ) : (
    <StatusDot status={status} />
  );
  return detail ? (
    <SimpleTooltip content={detail}>
      <span className="inline-flex">{indicator}</span>
    </SimpleTooltip>
  ) : (
    indicator
  );
}

export function AppStatusIndicator({
  status,
  runtime,
  neverDeployed = false,
}: {
  status: AppStatus;
  runtime: OverviewRuntimeView | null;
  neverDeployed?: boolean;
}) {
  return (
    <StatusIndicator
      status={displayStatus(status, runtime, neverDeployed)}
      detail={detailFor(runtime)}
      badge={false}
    />
  );
}
