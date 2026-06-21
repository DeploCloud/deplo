"use client";

import * as React from "react";
import { Search, ScrollText, FileSearch } from "lucide-react";
import { Input } from "@/components/ui/input";
import { CopyButton } from "@/components/shared/copy-button";
import { DownloadButton } from "@/components/shared/download-button";
import { StatusDot } from "@/components/shared/status-badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn, timeAgo } from "@/lib/utils";
import {
  LEVEL_BADGE_CLASS,
  LEVEL_LABEL,
  LEVEL_TEXT_CLASS,
  levelLabelPadded,
} from "@/lib/log-levels";
import type { DeploymentStatus, LogLevel, LogLine } from "@/lib/types";

export type DeploymentSummary = {
  id: string;
  projectName: string;
  projectSlug: string;
  commitMessage: string;
  status: DeploymentStatus;
  createdAt: string;
  branch: string;
};

const LEVELS: { value: LogLevel; label: string }[] = [
  { value: "command", label: "Command" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
  { value: "success", label: "Success" },
  { value: "debug", label: "Debug" },
];

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
}: {
  deployments: DeploymentSummary[];
  logsById: Record<string, LogLine[]>;
}) {
  const [selectedId, setSelectedId] = React.useState(deployments[0]?.id ?? "");
  const [query, setQuery] = React.useState("");
  const [activeLevels, setActiveLevels] = React.useState<Set<LogLevel>>(
    () => new Set(LEVELS.map((l) => l.value))
  );

  const selected = React.useMemo(
    () => deployments.find((d) => d.id === selectedId) ?? deployments[0],
    [deployments, selectedId]
  );

  const allLines = logsById[selected?.id ?? ""] ?? [];

  const filteredLines = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    return allLines.filter((line) => {
      if (!activeLevels.has(line.level)) return false;
      if (q && !line.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allLines, query, activeLevels]);

  const copyValue = React.useMemo(
    () =>
      filteredLines
        .map((l) => `[${fmtTime(l.ts)}] ${levelLabelPadded(l.level)} ${l.text}`)
        .join("\n"),
    [filteredLines]
  );

  const downloadName = selected
    ? `${selected.projectSlug}-${selected.id}.log`
    : "deployment.log";

  function toggleLevel(level: LogLevel) {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

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
                      {d.projectName}
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
        {/* Toolbar */}
        <div className="flex flex-col gap-3 border-b border-border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search logs…"
                className="h-9 pl-9"
              />
            </div>
            <CopyButton value={copyValue} label="Copy logs" />
            <DownloadButton
              value={copyValue}
              filename={downloadName}
              label="Download"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {LEVELS.map((l) => {
              const on = activeLevels.has(l.value);
              return (
                <button
                  key={l.value}
                  type="button"
                  onClick={() => toggleLevel(l.value)}
                  aria-pressed={on}
                  className={cn(
                    "cursor-pointer rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
                    on
                      ? "border-border bg-secondary text-foreground"
                      : "border-border/60 bg-transparent text-muted-foreground hover:text-foreground"
                  )}
                >
                  {l.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Terminal */}
        <div className="max-h-[540px] overflow-y-auto rounded-b-xl bg-[#0a0a0a] p-4 font-mono text-xs leading-relaxed">
          {filteredLines.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <FileSearch className="size-5 text-muted-foreground" />
              <p className="text-muted-foreground">
                {allLines.length === 0
                  ? "No logs available for this deployment."
                  : "No log lines match your filters."}
              </p>
            </div>
          ) : (
            filteredLines.map((line, i) => (
              <div
                key={i}
                className="flex gap-3 whitespace-pre-wrap break-words py-0.5"
              >
                <span className="shrink-0 select-none text-zinc-600">
                  [{fmtTime(line.ts)}]
                </span>
                <span
                  className={cn(
                    "shrink-0 select-none self-start rounded px-1.5 text-[10px] font-semibold uppercase leading-5 tracking-wide",
                    LEVEL_BADGE_CLASS[line.level] ?? "bg-zinc-700/30 text-zinc-300",
                  )}
                >
                  {LEVEL_LABEL[line.level] ?? line.level}
                </span>
                <span
                  className={cn(
                    "min-w-0 flex-1",
                    LEVEL_TEXT_CLASS[line.level] ?? "text-zinc-300",
                  )}
                >
                  {line.text}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
