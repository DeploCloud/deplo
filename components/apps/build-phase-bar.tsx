"use client";

import * as React from "react";
import { CircleCheck, CircleX } from "lucide-react";

import { SimpleTooltip } from "@/components/ui/tooltip";
import { buildPhases } from "@/lib/build-phases";
import { isDeploymentLive } from "@/lib/deployment-status";
import { cn, formatBuildDuration, formatClockTime } from "@/lib/utils";
import type { DeploymentStatus, LogLine } from "@/lib/types";

/** Same cadence as BuildDuration: the label never shows below a second. */
const TICK_MS = 1000;

/**
 * Where a build's time went, one segment per phase - derived from the `command`
 * lines the deployment already logged, so it costs a pass over the polled array.
 * The width carries the proportion; the pill holds only the time and an outcome.
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
    // Scrolls only where it has to: five phases need 394px, which no dashboard
    // column is short of and a phone is.
    <div className="overflow-x-auto">
      <div className="flex gap-1.5" aria-label="Build phases">
        {phases.map((phase, i) => {
          const last = i === phases.length - 1;
          const time = formatBuildDuration(phase.ms);
          const clock = formatClockTime(
            new Date(phase.startMs).toISOString(),
            true,
          );
          return (
            <div
              key={i}
              className="flex min-w-0 flex-col gap-1"
              // 4.625rem is measured, not guessed: the widest thing a NARROW phase
              // has to hold is its `HH:MM:SS.mmm` start (72.3px). Proportional above
              // that, never below it - a 300ms phase beside a 70s one still reads.
              style={{
                flexGrow: Math.max(phase.ms, 1),
                flexBasis: 0,
                minWidth: "4.625rem",
              }}
            >
              <span
                className={cn(
                  "truncate text-[11px]",
                  last && running
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {phase.label}
              </span>
              <SimpleTooltip
                content={`${phase.label} · ${time} · started ${clock}`}
              >
                <div className="flex h-6 items-center justify-end gap-1.5 rounded-md border border-border bg-secondary px-1.5">
                  <span className="truncate text-[11px] tabular-nums">
                    {time}
                  </span>
                  <PhaseOutcome last={last} status={status} running={running} />
                </div>
              </SimpleTooltip>
              <span className="truncate font-mono text-[10px] text-muted-foreground">
                {clock}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A phase is over unless it is the last one of a build still going. */
function PhaseOutcome({
  last,
  status,
  running,
}: {
  last: boolean;
  status: DeploymentStatus;
  running: boolean;
}) {
  if (last && running) {
    return (
      <span className="relative flex size-2.5 shrink-0" aria-label="Running">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--warning)] opacity-60" />
        <span className="relative inline-flex size-2.5 rounded-full bg-[var(--warning)]" />
      </span>
    );
  }
  // The build died in whichever phase was running when it stopped.
  if (last && status === "error") {
    return (
      <CircleX
        className="size-3.5 shrink-0 text-destructive"
        aria-label="Failed"
      />
    );
  }
  if (last && status === "canceled") {
    return (
      <span
        className="size-2.5 shrink-0 rounded-full bg-muted-foreground"
        aria-label="Canceled"
      />
    );
  }
  return (
    <CircleCheck
      className="size-3.5 shrink-0 text-[var(--success)]"
      aria-label="Done"
    />
  );
}
