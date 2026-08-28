"use client";

import * as React from "react";

import { SimpleTooltip } from "@/components/ui/tooltip";
import { buildPhases, type BuildPhaseKey } from "@/lib/build-phases";
import { isDeploymentLive } from "@/lib/deployment-status";
import { cn, formatBuildDuration } from "@/lib/utils";
import type { DeploymentStatus, LogLine } from "@/lib/types";

/** Same cadence as BuildDuration: the label never shows below a second. */
const TICK_MS = 1000;

/**
 * Preparation recedes, the build is the subject, the deploy is the good news -
 * the documented grey ladder (`--ring` → `--muted-foreground`), not `--primary`,
 * which is near-white on dark and paints the widest segment as a glare.
 */
const FILL: Record<BuildPhaseKey, string> = {
  initialize: "bg-ring text-foreground",
  clone: "bg-ring text-foreground",
  extract: "bg-ring text-foreground",
  pull: "bg-ring text-foreground",
  prepare: "bg-ring text-foreground",
  build: "bg-[var(--muted-foreground)] text-primary-foreground",
  deploy: "bg-[var(--success)] text-[var(--success-foreground)]",
};

/**
 * Where a build's time went, one segment per phase - derived from the `command`
 * lines the deployment already logged, so it costs a pass over the polled array.
 */
export function BuildPhaseBar({
  logs,
  status,
  startedAt,
  buildDurationMs,
}: {
  logs: LogLine[];
  status: DeploymentStatus;
  startedAt: string | null;
  buildDurationMs: number | null;
}) {
  const running =
    buildDurationMs == null && startedAt != null && isDeploymentLive(status);

  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [running]);

  const phases = React.useMemo(
    () => buildPhases({ logs, startedAt, buildDurationMs, nowMs: now }),
    [logs, startedAt, buildDurationMs, now],
  );
  if (phases.length === 0) return null;

  return (
    <div
      className="flex gap-px overflow-hidden rounded-xl border border-border"
      aria-label="Build phases"
    >
      {phases.map((phase, i) => {
        const last = i === phases.length - 1;
        const time = formatBuildDuration(phase.ms);
        return (
          <SimpleTooltip key={i} content={`${phase.label} · ${time}`}>
            <div
              className={cn(
                "flex flex-col items-center justify-center px-1 py-1.5",
                // The build died in whichever phase was running when it stopped.
                last && status === "error"
                  ? "bg-destructive text-destructive-foreground"
                  : FILL[phase.key],
                last && running && "animate-pulse",
              )}
              // 4rem is measured, not guessed: the longest label ("Initialize",
              // 46px) and the longest time ("12m 34s", 53px) both have to fit.
              style={{
                flexGrow: Math.max(phase.ms, 1),
                flexBasis: 0,
                minWidth: "4rem",
              }}
            >
              <span className="w-full truncate text-center text-[11px]">
                {phase.label}
              </span>
              <span className="w-full truncate text-center text-xs font-medium tabular-nums">
                {time}
              </span>
            </div>
          </SimpleTooltip>
        );
      })}
    </div>
  );
}
