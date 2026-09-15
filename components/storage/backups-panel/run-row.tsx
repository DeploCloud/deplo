"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/shared/status-badge";
import { formatBytes, formatDateTime, timeAgo } from "@/lib/utils";
import type { BackupRun } from "@/lib/types/backup";
import type { BackupTarget } from "./target";
import { RunMenu } from "./run-menu";
import {
  CancelRunDialog,
  DeleteRunDialog,
  RestoreRunDialog,
} from "./run-dialogs";

export function PendingRunRow({
  destinationName,
  canRestore,
}: {
  destinationName: string;
  canRestore: boolean;
}) {
  return (
    <TableRow aria-busy className="animate-pulse select-none">
      <TableCell>
        <div className="flex items-center gap-2">
          <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          <span className="text-sm font-medium">Running</span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          just now · {destinationName}
        </p>
      </TableCell>
      <TableCell className="text-right text-muted-foreground">-</TableCell>
      <TableCell className="w-px text-right">
        <RunMenu href={null} running ok={false} canRestore={canRestore} />
      </TableCell>
    </TableRow>
  );
}

export function RunRow({
  run,
  target,
  destinationName,
  canRestore,
  canDelete,
  canManage,
}: {
  run: BackupRun;
  target: BackupTarget;
  destinationName: string;
  canRestore: boolean;
  canDelete: boolean;
  canManage: boolean;
}) {
  const [restoreOpen, setRestoreOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const ok = run.status === "success";
  const running = run.status === "running";

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          {running ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <StatusDot status={run.status} />
          )}
          <span className="text-sm font-medium">
            {running ? "Running" : timeAgo(run.startedAt)}
          </span>
          {!running && !ok && (
            <span className="text-xs text-muted-foreground capitalize">
              {run.status}
            </span>
          )}
        </div>
        <p
          className="mt-1 text-xs text-muted-foreground"
          suppressHydrationWarning
        >
          {formatDateTime(run.startedAt)} · {destinationName}
          {ok && !run.sha256 && (
            <SimpleTooltip content="Taken before Deplo recorded checksums, so it cannot prove this file is unchanged">
              <span> · not checksummed</span>
            </SimpleTooltip>
          )}
        </p>
        {run.error && (
          <SimpleTooltip content={run.error}>
            <p className="mt-1 line-clamp-2 text-xs text-destructive">
              {run.error}
            </p>
          </SimpleTooltip>
        )}
      </TableCell>
      <TableCell className="text-right text-muted-foreground">
        {ok ? formatBytes(run.sizeBytes) : "-"}
      </TableCell>
      <TableCell className="w-px text-right">
        <RunMenu
          href={`/api/backups/${run.id}/download`}
          running={running}
          ok={ok}
          canRestore={canRestore}
          canDelete={canDelete}
          canManage={canManage}
          onRestore={() => setRestoreOpen(true)}
          onDelete={() => setDeleteOpen(true)}
          onCancel={() => setCancelOpen(true)}
        />
        <CancelRunDialog
          runId={run.id}
          open={cancelOpen}
          onOpenChange={setCancelOpen}
        />
        <RestoreRunDialog
          run={run}
          target={target}
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
        />
        <DeleteRunDialog
          run={run}
          target={target}
          destinationName={destinationName}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
        />
      </TableCell>
    </TableRow>
  );
}
