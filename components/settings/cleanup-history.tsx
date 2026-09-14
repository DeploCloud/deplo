"use client";

import * as React from "react";
import { History, Loader2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { InfoTip } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { StatusDot } from "@/components/shared/status-badge";
import { formatBuildDuration, formatBytes, timeAgo } from "@/lib/utils";
import type { CleanupRunDTO } from "@/lib/data/docker-cleanup/run-history";

const STATUS_LABELS: Record<CleanupRunDTO["status"], string> = {
  running: "Running",
  success: "Succeeded",
  failed: "Failed",
};

// CleanupHistory - the last sweeps, newest first, at most 3 per server.
export function CleanupHistory({
  runs,
  hideServer,
}: {
  runs: CleanupRunDTO[];
  hideServer?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          <History className="size-4" />
          Recent cleanups
          <InfoTip
            content="The last three runs per server, scheduled and manual alike. Older runs are pruned automatically."
            docs="servers.cleanup"
          />
        </CardTitle>
      </CardHeader>
      <CardContent>
        {runs.length === 0 ? (
          <EmptyState
            icon={History}
            title="No cleanups yet"
            docs="servers.cleanup"
            description="Runs appear here once the schedule fires or you clean up a server by hand."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  {hideServer ? null : <TableHead>Server</TableHead>}
                  <TableHead>Trigger</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Reclaimed</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    {hideServer ? null : (
                      <TableCell className="font-medium">
                        {run.serverName}
                      </TableCell>
                    )}
                    <TableCell className="text-muted-foreground capitalize">
                      {run.trigger}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {run.actor}
                    </TableCell>
                    <TableCell>
                      {run.status === "running" ? (
                        <span className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
                          <Loader2 className="size-3.5 animate-spin" />
                          {STATUS_LABELS.running}
                          <Elapsed startedAt={run.startedAt} />
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 text-xs">
                          <StatusDot status={run.status} />
                          {STATUS_LABELS[run.status]}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {run.status === "success"
                        ? formatBytes(run.reclaimedBytes)
                        : "—"}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-muted-foreground"
                      title={run.startedAt}
                    >
                      {timeAgo(run.startedAt)}
                    </TableCell>
                    {/* The agent's own message, verbatim. */}
                    <TableCell className="max-w-xs">
                      {run.error ? (
                        <span
                          className="block truncate text-xs text-destructive"
                          title={run.error}
                        >
                          {run.error}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {summarize(run)}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Elapsed({ startedAt }: { startedAt: string }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <span className="tabular-nums" suppressHydrationWarning>
      {formatBuildDuration(now - Date.parse(startedAt))}
    </span>
  );
}

function summarize(run: CleanupRunDTO): string {
  // A run in flight has no items yet, so "Nothing to reclaim" would be wrong.
  if (run.status === "running") return "Reclaiming disk on the host";
  const swept = run.items.filter((i) => !i.skipped && !i.error);
  const objects = swept.reduce((n, i) => n + i.itemsRemoved, 0);
  if (objects === 0) return "Nothing to reclaim";
  return `${objects} object${objects === 1 ? "" : "s"} across ${swept.length} scope${
    swept.length === 1 ? "" : "s"
  }`;
}
