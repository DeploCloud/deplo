"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { CircleStop, Loader2, ScrollText } from "lucide-react";

import { formatBuildDuration } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { isDriven } from "@/components/layout/migration-activity";
import { copyFor, type SourceKind } from "../sources";
import { StepShell } from "../step-shell";
import type { MigrationProgress } from "../types";

// MovingPanel - what the review turns into once the move starts.
export function MovingPanel({
  kind,
  progress,
  startedAt,
  heartbeatAt,
  failure,
  running,
  undoing,
  onShowLog,
  onStop,
  onBack,
  isTakeover = false,
  team = null,
}: {
  kind: SourceKind | null;
  team?: { name: string; at: number; of: number } | null;
  progress: MigrationProgress;
  startedAt: number | null;
  heartbeatAt: string | null;
  failure: string | null;
  running: boolean;
  undoing: boolean;
  onShowLog: () => void;
  onStop?: () => void;
  onBack: () => void;
  isTakeover?: boolean;
}) {
  const pct = progress.total === 0 ? 0 : (progress.done / progress.total) * 100;
  // A heartbeat goes cold with the clock and nothing else: no frame arrives to
  // say so, so the panel has to change its mind on its own.
  const now = useNow(startedAt != null || heartbeatAt != null);
  const driven = isDriven({ heartbeatAt }, now);
  const panelName = copyFor(kind).name;

  if (!running && !undoing)
    return (
      <StepShell
        hero
        title="The migration could not start"
        lead={failure ?? "Deplo could not start the migration."}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onBack}>
            Back to the review
          </Button>
        </div>
      </StepShell>
    );

  return (
    <StepShell
      hero
      title={
        undoing
          ? "Undoing the migration"
          : driven
            ? "Migration in progress"
            : "Waiting to start"
      }
      lead={
        undoing
          ? "Deplo is removing everything this migration created and taking its agent back off the machines it was reading. Nothing is left half moved."
          : driven
            ? isTakeover
              ? "Deplo is doing this on the server. Reload this page any time to come back to it."
              : "Deplo is doing this on the server. Close the page if you like - the chip in the header brings you back."
            : "Deplo has not started this migration yet. It starts on its own within a minute or two. Stop it if you would rather start again."
      }
    >
      <div className="space-y-2 text-center">
        {team && (
          <p className="text-sm">
            <span className="font-medium">{team.name}</span>
            <span className="text-muted-foreground">
              {` · team ${team.at} of ${team.of}`}
            </span>
          </p>
        )}
        <div className="flex items-center gap-3">
          <Progress
            value={pct}
            className={cn(driven && "deplo-progress-working")}
          />
          {driven && (
            <Loader2 className="size-4 shrink-0 animate-spin text-primary" />
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {undoing
            ? "Removing what came over"
            : !driven
              ? "Not started yet"
              : [
                  progress.total > 0 &&
                    `Project ${Math.min(progress.done + 1, progress.total)} of ${progress.total}`,
                  progress.current,
                ]
                  .filter(Boolean)
                  .join(" \u00b7 ")}
        </p>
        <ElapsedLine startedAt={startedAt} progress={progress} now={now} />
      </div>

      <div
        className={cn(
          "flex flex-wrap items-center gap-2",
          onStop && !undoing ? "justify-between" : "justify-end",
        )}
      >
        {onStop && !undoing && (
          <ConfirmAction
            trigger={
              <Button variant="outline">
                <CircleStop className="size-4" />
                Stop
              </Button>
            }
            title="Stop the migration and undo it?"
            confirmLabel="Stop and undo"
            description={
              <>
                Deplo undoes this migration and takes its agent back off the
                machines it was reading.{" "}
                <strong>There is no half-migrated state to keep.</strong>
              </>
            }
            consequence={`Every app, database and project it created here is removed with its data, and ${panelName} is not started back up.`}
            onConfirm={async () => {
              onStop();
              return { ok: true as const, data: null };
            }}
          />
        )}
        <Button variant="ghost" onClick={onShowLog}>
          <ScrollText className="size-4" />
          Show log
        </Button>
      </div>
    </StepShell>
  );
}

// useNow - the panel's clock, ticking once a second while there is a run.
function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

// ElapsedLine - how long it has been going, and roughly how much is left.
function ElapsedLine({
  startedAt,
  progress,
  now,
}: {
  startedAt: number | null;
  progress: MigrationProgress;
  now: number;
}) {
  if (startedAt == null) return null;
  const elapsed = Math.max(0, now - startedAt);
  const left =
    progress.done > 0 && progress.total > progress.done
      ? Math.round((elapsed / progress.done) * (progress.total - progress.done))
      : null;

  return (
    <p className="text-xs text-muted-foreground">
      Running for {formatBuildDuration(elapsed)}
      {left != null && ` \u00b7 about ${formatBuildDuration(left)} left`}
    </p>
  );
}
