"use client";

import * as React from "react";

import { isDeploymentLive } from "@/lib/deployment-status";
import { formatBuildDuration } from "@/lib/utils";
import type { DeploymentStatus } from "@/lib/types/deployment";

const TICK_MS = 1000;

// BuildDuration - build time, kept honest while the build is still running.
export function BuildDuration({
  status,
  startedAt,
  buildDurationMs,
  className,
}: {
  status: DeploymentStatus;
  startedAt: string | null;
  buildDurationMs: number | null;
  className?: string;
}) {
  const running =
    buildDurationMs == null && startedAt != null && isDeploymentLive(status);

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  const text =
    buildDurationMs != null
      ? formatBuildDuration(buildDurationMs)
      : running
        ? formatBuildDuration(now - Date.parse(startedAt!))
        : "—";

  return (
    <span className={className} suppressHydrationWarning>
      {text}
    </span>
  );
}
