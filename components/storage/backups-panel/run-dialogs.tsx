"use client";

import { useRouter } from "@/lib/nav";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { DocsLink } from "@/components/ui/docs-link";
import { useOptimisticRow } from "@/components/shared/optimistic-list";
import { formatBytes, timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { BackupRun } from "@/lib/types/backup";
import { noun, type BackupTarget } from "./target";

// CancelRunDialog - stop a dump that is still running, keeping nothing.
export function CancelRunDialog({
  runId,
  open,
  onOpenChange,
}: {
  runId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title="Stop this backup?"
      confirmLabel="Stop backup"
      successMessage="Backup stopped"
      description="The dump stops on the server and nothing is kept: the half-written file is removed, so this leaves no backup behind."
      onConfirm={async () => {
        const res = await gqlAction(
          `mutation($runId: String!) { cancelBackupRun(runId: $runId) }`,
          { runId },
        );
        if (res.ok) router.refresh();
        return res;
      }}
    />
  );
}

// RestoreRunDialog - put this artifact back over the live target, in place.
export function RestoreRunDialog({
  run,
  target,
  open,
  onOpenChange,
}: {
  run: BackupRun;
  target: BackupTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title="Restore this backup?"
      confirmLabel="Restore"
      successMessage="Restore started"
      confirmText={target.name}
      description={
        <>
          This overwrites <strong>{target.name}</strong> in place with the
          backup from {timeAgo(run.startedAt)}.{" "}
          <DocsLink topic="backups.restore" />
        </>
      }
      consequence={`The ${noun(target)} is stopped and its current data is wiped. The current state is not recoverable.`}
      onConfirm={async () => {
        const res = await gqlAction(
          `mutation($runId: String!) { restoreBackup(runId: $runId) }`,
          { runId: run.id },
        );
        if (res.ok) router.refresh();
        return res;
      }}
    />
  );
}

// DeleteRunDialog - drop one artifact, or the record a failed run left behind.
export function DeleteRunDialog({
  run,
  target,
  destinationName,
  open,
  onOpenChange,
}: {
  run: BackupRun;
  target: BackupTarget;
  destinationName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const { hide, restore } = useOptimisticRow(run.id);
  const ok = run.status === "success";
  // No typed confirmation, unlike Restore: ceremony everywhere is ceremony nowhere.
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title="Delete this backup?"
      confirmLabel="Delete backup"
      successMessage="Backup deleted"
      description={
        ok ? (
          <>
            The {formatBytes(run.sizeBytes)} file from {timeAgo(run.startedAt)}{" "}
            is deleted from <strong>{destinationName}</strong>.
          </>
        ) : (
          "This run failed and left no file, so only its record is removed."
        )
      }
      consequence={
        ok ? `You can't restore ${target.name} from it afterwards.` : undefined
      }
      optimistic
      onConfirm={async () => {
        hide();
        const res = await gqlAction(
          `mutation($runId: String!) { deleteBackupRun(runId: $runId) }`,
          { runId: run.id },
        );
        if (!res.ok) restore();
        router.refresh();
        return res;
      }}
    />
  );
}
