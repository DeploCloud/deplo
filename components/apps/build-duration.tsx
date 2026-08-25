"use client";

import * as React from "react";

import { isDeploymentLive } from "@/lib/deployment-status";
import { formatBuildDuration } from "@/lib/utils";
import type { DeploymentStatus } from "@/lib/types";

/**
 * Repaint cadence. The label renders milliseconds only in its first second, and
 * a running build has no reason to repaint faster than the seconds it will show
 * for the rest of its life.
 */
const TICK_MS = 1000;

/**
 * "Build time" - the one deployment field that has to be honest WHILE it is still
 * happening.
 */
export function BuildDuration({
  status,
  startedAt,
  buildDurationMs,
  className,
}: {
  status: DeploymentStatus;
  /** When the build started running; null while it is still queued. */
  startedAt: string | null;
  /** The measured build time, once the deployment has settled. */
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
