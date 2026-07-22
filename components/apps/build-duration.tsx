"use client";

import * as React from "react";

import { isDeploymentLive } from "@/lib/deployment-status";
import { formatBuildDuration } from "@/lib/utils";
import type { DeploymentStatus } from "@/lib/types";

/** Repaint cadence. Seconds is the finest unit the label renders. */
const TICK_MS = 1000;

/**
 * "Build time" — the one deployment field that has to be honest WHILE it is
 * still happening.
 *
 * A finished build shows the duration the control plane measured. A running one
 * has no duration yet, so instead of the blank cell this field used to be, it
 * counts up live from `startedAt` — the instant the queue drain claimed the
 * build, which is the very origin the final `buildDurationMs` is measured from,
 * so the ticking number and the number that lands agree to the second.
 *
 * Not started (still queued) or finished without a measurement (a build orphaned
 * by a control-plane restart) ⇒ "—": nothing was timed, so nothing is claimed.
 *
 * The timer counts against the VIEWER's clock from an absolute timestamp, so it
 * can't go stale behind a cached page render, and it clamps at zero so a browser
 * clock running behind the host's can never show a negative build time. The
 * server's own value is what paints first; `suppressHydrationWarning` covers the
 * sub-second disagreement between the two clocks at hydration, and the first
 * tick takes over a second later.
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
