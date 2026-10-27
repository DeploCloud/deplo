"use client";

import * as React from "react";
import {
  AlertTriangle,
  Ban,
  CircleCheck,
  CircleX,
  Clock,
  Loader2,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { DetailRow, DetailRows } from "@/components/apps/detail-rows";
import { BuildLogStream } from "@/components/apps/build-log-stream";
import { BuildDuration } from "@/components/apps/build-duration";
import { isDeploymentLive } from "@/lib/deployment-status";
import { cn } from "@/lib/utils";
import type {
  DeploymentStatus,
  LogLevel,
  LogLine,
} from "@/lib/types/deployment";

const ISSUE_LEVELS: LogLevel[] = ["warn", "error"];

export function StepIcon({ status }: { status: DeploymentStatus }) {
  if (status === "ready")
    return (
      <CircleCheck className="size-5 shrink-0 fill-[var(--info)] text-background" />
    );
  if (status === "error")
    return (
      <CircleX className="size-5 shrink-0 fill-destructive text-background" />
    );
  if (status === "building")
    return (
      <Loader2 className="size-5 shrink-0 animate-spin text-[var(--warning)]" />
    );
  if (status === "queued")
    return <Clock className="size-5 shrink-0 text-muted-foreground" />;
  return <Ban className="size-5 shrink-0 text-muted-foreground" />;
}

export function DeploymentSections({
  deploymentId,
  status,
  startedAt,
  buildDurationMs,
  queuePosition,
  logs,
  logsLocked,
  summary,
  summaryMeta,
  domains,
  domainsMeta,
}: {
  deploymentId: string;
  status: DeploymentStatus;
  startedAt: string | null;
  buildDurationMs: number | null;
  queuePosition: number | null;
  logs: LogLine[];
  // Shown in place of the stream when the viewer cannot read logs.
  logsLocked: React.ReactNode;
  summary: React.ReactNode;
  summaryMeta: React.ReactNode;
  domains: React.ReactNode;
  domainsMeta: React.ReactNode;
}) {
  const [open, setOpen] = React.useState<string[]>(() =>
    isDeploymentLive(status) ? ["logs"] : [],
  );
  const [levelFilter, setLevelFilter] = React.useState<{
    levels: LogLevel[];
  }>();

  const warnings = logs.filter((l) => l.level === "warn").length;
  const errors = logs.filter((l) => l.level === "error").length;

  function showIssues() {
    setOpen((o) => (o.includes("logs") ? o : [...o, "logs"]));
    setLevelFilter({ levels: ISSUE_LEVELS });
  }

  return (
    <Card className="overflow-hidden">
      <DetailRows value={open} onValueChange={setOpen}>
        <DetailRow
          value="logs"
          title="Build Logs"
          className="p-4"
          meta={
            <>
              {!logsLocked && warnings + errors > 0 && (
                <button
                  type="button"
                  onClick={showIssues}
                  aria-label="Show warnings and errors"
                  className="flex cursor-pointer items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs font-medium hover:bg-surface-strong"
                >
                  <AlertTriangle
                    className={cn(
                      "size-3.5",
                      errors ? "text-destructive" : "text-[var(--warning)]",
                    )}
                  />
                  {warnings + errors}
                </button>
              )}
              <span className="text-muted-foreground tabular-nums">
                <BuildDuration
                  status={status}
                  startedAt={startedAt}
                  buildDurationMs={buildDurationMs}
                />
              </span>
              <StepIcon status={status} />
            </>
          }
        >
          {logsLocked ?? (
            <BuildLogStream
              deploymentId={deploymentId}
              initialLogs={logs}
              initialStatus={status}
              initialQueuePosition={queuePosition}
              initialStartedAt={startedAt}
              initialBuildDurationMs={buildDurationMs}
              levelFilter={levelFilter}
            />
          )}
        </DetailRow>
        <DetailRow
          value="summary"
          title="Deployment Summary"
          meta={summaryMeta}
          className="px-5 py-4"
        >
          {summary}
        </DetailRow>
        {domains && (
          <DetailRow value="domains" title="Domains" meta={domainsMeta}>
            {domains}
          </DetailRow>
        )}
      </DetailRows>
    </Card>
  );
}
