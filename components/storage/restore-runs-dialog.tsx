"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, AlertTriangle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { formatBytes, timeAgo } from "@/lib/utils";
import { gql, gqlAction } from "@/lib/graphql-client";

type BackupRunLite = {
  id: string;
  status: "running" | "success" | "failed";
  sizeBytes: number;
  startedAt: string;
  error: string | null;
};

/**
 * Lists a backup target's recent runs and restores a chosen one in place. Used
 * from the storage Backups table (a schedule row's "Restore…" action) where the
 * runs aren't already on the page — so it lazy-loads them via `backupRuns` the
 * first time it opens. Restore is irreversible (overwrites the live target), so
 * each one is behind a typed confirmation.
 */
export function RestoreRunsDialog({
  open,
  onOpenChange,
  targetKind,
  targetId,
  targetName,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  targetKind: "database" | "project";
  targetId: string;
  targetName: string;
}) {
  const router = useRouter();
  const [runs, setRuns] = React.useState<BackupRunLite[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Lazy-load on open; reload each time it opens so the list stays current after
  // a fresh "Run now". Aborts if the dialog closes mid-flight. The `runs`/`error`
  // reset happens on CLOSE (handleOpenChange) — keeping the effect body free of a
  // synchronous setState so loading state is null again before the next open.
  React.useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const arg = targetKind === "project" ? "projectId" : "databaseId";
    gql<{ backupRuns: BackupRunLite[] }>(
      `query($id: String) {
        backupRuns(${arg}: $id) {
          id status sizeBytes startedAt error
        }
      }`,
      { id: targetId },
      controller.signal,
    )
      .then((d) => setRuns(d.backupRuns))
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : "Failed to load runs");
      });
    return () => controller.abort();
  }, [open, targetKind, targetId]);

  // Reset to the loading state on close, so re-opening shows the spinner and
  // re-fetches rather than flashing the previous target's runs.
  const handleOpenChange = (v: boolean) => {
    if (!v) {
      setRuns(null);
      setError(null);
    }
    onOpenChange(v);
  };

  const successfulRuns = (runs ?? []).filter((r) => r.status === "success");

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Restore {targetName}</DialogTitle>
          <DialogDescription>
            Pick a backup to restore in place. This overwrites the live{" "}
            {targetKind} — there is downtime and the current state is not
            recoverable.
          </DialogDescription>
        </DialogHeader>

        {runs === null && !error ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading backups…
          </div>
        ) : error ? (
          <p className="py-6 text-sm text-destructive">{error}</p>
        ) : successfulRuns.length === 0 ? (
          <p className="py-6 text-sm text-muted-foreground">
            No completed backups to restore yet.
          </p>
        ) : (
          <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {successfulRuns.map((run) => (
                  <RestoreRunRow
                    key={run.id}
                    run={run}
                    targetKind={targetKind}
                    targetName={targetName}
                    onRestored={() => {
                      onOpenChange(false);
                      router.refresh();
                    }}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function RestoreRunRow({
  run,
  targetKind,
  targetName,
  onRestored,
}: {
  run: BackupRunLite;
  targetKind: "database" | "project";
  targetName: string;
  onRestored: () => void;
}) {
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  return (
    <TableRow>
      <TableCell className="text-sm">{timeAgo(run.startedAt)}</TableCell>
      <TableCell className="text-muted-foreground">
        {formatBytes(run.sizeBytes)}
      </TableCell>
      <TableCell>
        <span className="flex items-center gap-1.5 text-xs capitalize">
          <StatusDot status={run.status} />
          {run.status}
        </span>
      </TableCell>
      <TableCell className="text-right">
        <SimpleTooltip content="Restore this backup in place">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirmOpen(true)}
          >
            <RotateCcw className="size-4" />
            Restore
          </Button>
        </SimpleTooltip>
        <ConfirmAction
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Restore this backup?"
          confirmLabel="Restore"
          successMessage="Restore started"
          confirmText={targetName}
          description={
            <span className="flex items-start gap-2 text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                This overwrites <strong>{targetName}</strong> in place with the
                backup from {timeAgo(run.startedAt)}. The {targetKind} is taken
                offline while it restores and its current state is{" "}
                <strong>not recoverable</strong>.
              </span>
            </span>
          }
          onConfirm={async () => {
            const res = await gqlAction(
              `mutation($runId: String!) { restoreBackup(runId: $runId) }`,
              { runId: run.id },
            );
            if (res.ok) onRestored();
            return res;
          }}
        />
      </TableCell>
    </TableRow>
  );
}
