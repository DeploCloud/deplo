"use client";

import * as React from "react";
import { History, Loader2 } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SortableHead, useTableSort } from "@/components/ui/table-sort";
import {
  Table,
  TableBody,
  TableCell,
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

const CLEANUP_SORT = {
  server: (r: CleanupRunDTO) => r.serverName,
  trigger: (r: CleanupRunDTO) => r.trigger,
  actor: (r: CleanupRunDTO) => r.actor,
  status: (r: CleanupRunDTO) => STATUS_LABELS[r.status],
  reclaimed: (r: CleanupRunDTO) =>
    r.status === "running" ? null : r.reclaimedBytes,
  when: (r: CleanupRunDTO) => Date.parse(r.startedAt),
  details: (r: CleanupRunDTO) => r.error || cleanupSummary(r),
};

export function CleanupHistory({
  runs,
  hideServer,
}: {
  runs: CleanupRunDTO[];
  hideServer?: boolean;
}) {
  const sorted = useTableSort(runs, CLEANUP_SORT);
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
          <div className="overflow-x-auto rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  {hideServer ? null : (
                    <SortableHead
                      column="server"
                      sort={sorted.sort}
                      onSort={sorted.toggle}
                    >
                      Server
                    </SortableHead>
                  )}
                  <SortableHead
                    column="trigger"
                    sort={sorted.sort}
                    onSort={sorted.toggle}
                  >
                    Trigger
                  </SortableHead>
                  <SortableHead
                    column="actor"
                    sort={sorted.sort}
                    onSort={sorted.toggle}
                  >
                    Actor
                  </SortableHead>
                  <SortableHead
                    column="status"
                    sort={sorted.sort}
                    onSort={sorted.toggle}
                  >
                    Status
                  </SortableHead>
                  <SortableHead
                    column="reclaimed"
                    sort={sorted.sort}
                    onSort={sorted.toggle}
                    align="right"
                  >
                    Reclaimed
                  </SortableHead>
                  <SortableHead
                    column="when"
                    sort={sorted.sort}
                    onSort={sorted.toggle}
                  >
                    When
                  </SortableHead>
                  <SortableHead
                    column="details"
                    sort={sorted.sort}
                    onSort={sorted.toggle}
                  >
                    Details
                  </SortableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.rows.map((run) => (
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
                      {run.status !== "running"
                        ? formatBytes(run.reclaimedBytes)
                        : "-"}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-muted-foreground"
                      title={run.startedAt}
                    >
                      {timeAgo(run.startedAt)}
                    </TableCell>
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
                          {cleanupSummary(run)}
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

export function cleanupSummary(run: CleanupRunDTO): string {
  if (run.status === "running") return "Reclaiming disk on the host";
  const swept = run.items.filter((i) => !i.skipped && !i.error);
  const objects = swept.reduce((n, i) => n + i.itemsRemoved, 0);
  if (objects === 0)
    return run.reclaimedBytes > 0
      ? "Cleanup completed under the current rules"
      : "No items eligible under the cleanup rules";
  return `${objects} object${objects === 1 ? "" : "s"} across ${swept.length} scope${
    swept.length === 1 ? "" : "s"
  }`;
}
