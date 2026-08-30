"use client";

import * as React from "react";
import { CircleCheck, CircleX } from "lucide-react";

import { SimpleTooltip } from "@/components/ui/tooltip";
import { buildPhases } from "@/lib/build-phases";
import { isDeploymentLive } from "@/lib/deployment-status";
import { cn, formatBuildDuration, formatClockTime } from "@/lib/utils";
import type { DeploymentStatus, LogLine } from "@/lib/types";

/**
 * Half the growth transition, so the running phase is moving far more of the time
 * than it is still. Free: the 500ms log poll already re-renders this at that rate.
 */
const TICK_MS = 500;

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

  // The bar appearing is not an entrance (globals.css: page entrances are not
  // animated) - only a phase that STARTS while you watch opens. Phases are
  // append-only, so that is an index comparison against however many the bar
  // first painted. Adjusted during render, not in an effect: an effect runs after
  // the commit, which is one frame of every phase opening at once.
  const [painted, setPainted] = React.useState(0);
  if (painted === 0 && phases.length > 0) setPainted(phases.length);

  if (phases.length === 0) return null;

  return (
    // Scrolls only where it has to: five phases need 394px, which no dashboard
    // column is short of and a phone is.
    <div className="overflow-x-auto">
      <div
        className="flex gap-1.5 [--phase-min:4.625rem]"
        aria-label="Build phases"
      >
        {phases.map((phase, i) => {
          const last = i === phases.length - 1;
          const opening = painted > 0 && i >= painted;
          const time = formatBuildDuration(phase.ms);
          const clock = formatClockTime(
            new Date(phase.startMs).toISOString(),
            true,
          );
          return (
            <div
              key={i}
              className={cn(
                // --phase-min is measured, not guessed: the widest thing a NARROW
                // phase has to hold is its `HH:MM:SS.mmm` start (72.3px).
                // Proportional above that, never below it.
                "flex min-w-[var(--phase-min)] flex-col gap-1 overflow-hidden",
                // Every column, not just the running one: as the total grows they
                // all lose share, and they have to lose it just as smoothly.
                "transition-[flex-grow] duration-300 ease-out",
                opening && "animate-phase-in",
              )}
              style={{ flexGrow: Math.max(phase.ms, 1), flexBasis: 0 }}
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
