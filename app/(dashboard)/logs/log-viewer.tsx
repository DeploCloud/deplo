"use client";

import * as React from "react";
import { FileSearch, Lock } from "lucide-react";
import { CopyButton } from "@/components/shared/copy-button";
import { DownloadButton } from "@/components/shared/download-button";
import { StatusDot } from "@/components/shared/status-badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { LogLines, LogRow } from "@/components/shared/log-line-row";
import {
  LogSearch,
  LogLevelFilter,
  useLogFilters,
  BUILD_LEVELS,
} from "@/components/logs/log-filters";
import { cn, timeAgo } from "@/lib/utils";
import { stripAnsi } from "@/lib/ansi";
import { levelLabelPadded } from "@/lib/log-levels";
import type { DeploymentStatus, LogLine } from "@/lib/types";

export type DeploymentSummary = {
  id: string;
  serviceName: string;
  appSlug: string;
  commitMessage: string;
  status: DeploymentStatus;
  createdAt: string;
  branch: string;
};

function fmtTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  // Use a fixed UTC HH:MM:SS. `toLocaleTimeString` pins the locale but not the
  // timezone, so a non-UTC server and a UTC browser format the same instant
  // differently → hydration mismatch. getUTC* is deterministic everywhere.
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

export function LogViewer({
  deployments,
  logsById,
  closedIds = [],
}: {
  deployments: DeploymentSummary[];
  logsById: Record<string, LogLine[]>;
  /** Deployments whose logs the viewer may not read (`view_logs` is per app).
   *  Their pane says so instead of reading as a build that printed nothing. */
  closedIds?: string[];
}) {
  const [selectedId, setSelectedId] = React.useState(deployments[0]?.id ?? "");

  const selected = React.useMemo(
    () => deployments.find((d) => d.id === selectedId) ?? deployments[0],
    [deployments, selectedId]
  );

  const allLines = logsById[selected?.id ?? ""] ?? [];
  const closed = React.useMemo(() => new Set(closedIds), [closedIds]);
  const selectionClosed = Boolean(selected && closed.has(selected.id));

  // Search + level filter, the same kit the live pane and the build-log stream
  // use. It matches against the PLAIN text: lines are stored with their ANSI
  // escapes (LogRow renders them as colors), and an `\x1b[33m` glued to a word
  // would otherwise make it unsearchable.
  const filters = useLogFilters(allLines, BUILD_LEVELS);
  const filteredLines = filters.shown;

  const copyValue = React.useMemo(
    () =>
      filteredLines
        .map(
          (l) =>
            `[${fmtTime(l.ts)}] ${levelLabelPadded(l.level)} ${stripAnsi(l.text)}`
        )
        .join("\n"),
    [filteredLines]
  );

  const downloadName = selected
    ? `${selected.appSlug}-${selected.id}.log`
    : "deployment.log";

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      {/* Deployment list */}
      <div className="rounded-xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Recent deployments
          </p>
        </div>
        <ScrollArea className="max-h-[600px]">
          <div className="divide-y divide-border">
            {deployments.map((d) => {
              const isActive = d.id === selected?.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setSelectedId(d.id)}
                  className={cn(
                    "flex w-full cursor-pointer flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-secondary/60",
                    isActive && "bg-secondary"
                  )}
                >
                  <div className="flex items-center gap-2">
                    <StatusDot status={d.status} />
                    <span className="truncate text-sm font-medium text-foreground">
                      {d.serviceName}
                    </span>
                  </div>
                  <p className="line-clamp-1 text-xs text-muted-foreground">
                    {d.commitMessage}
                  </p>
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="truncate font-mono">{d.branch}</span>
                    <span aria-hidden>·</span>
                    <span className="shrink-0">{timeAgo(d.createdAt)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </ScrollArea>
      </div>

      {/* Log panel */}
      <div className="flex min-w-0 flex-col rounded-xl border border-border bg-card">
        {/* Toolbar. The six hand-rolled level pills that used to sit on a second
            row are now the shared level facet — one control, with per-level row
            counts, matching the live pane and the build-log stream. */}
        <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
          <LogSearch
            value={filters.state.q}
            onChange={(q) => filters.setState((s) => ({ ...s, q }))}
          />
          <LogLevelFilter
            facet={filters.facet}
            values={filters.state.levels}
            counts={filters.counts}
            onChange={(levels) => filters.setState((s) => ({ ...s, levels }))}
          />
          <CopyButton value={copyValue} label="Copy logs" />
          <DownloadButton
            value={copyValue}
            filename={downloadName}
            label="Download"
          />
        </div>

        {/* Terminal */}
        <LogLines className="max-h-[540px] rounded-b-xl text-xs">
          {filteredLines.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              {selectionClosed ? (
                <Lock className="size-5 text-muted-foreground" />
              ) : (
                <FileSearch className="size-5 text-muted-foreground" />
              )}
              <p className="text-muted-foreground">
                {selectionClosed
                  ? "You don't have permission to read this app's logs. Ask a team admin for the “View logs” permission."
                  : allLines.length === 0
                    ? "No logs available for this deployment."
                    : "No log lines match your filters."}
              </p>
            </div>
          ) : (
            filteredLines.map((line, i) => (
              <LogRow
                key={i}
                level={line.level}
                text={line.text}
                time={`[${fmtTime(line.ts)}]`}
                highlight={filters.highlight}
              />
            ))
          )}
        </LogLines>
      </div>
    </div>
  );
}
