"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Play,
  Pencil,
  Trash2,
  MoreHorizontal,
  RotateCcw,
  Database as DatabaseIcon,
  Boxes,
  Loader2,
} from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusDot } from "@/components/shared/status-badge";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { RestoreRunsDialog } from "@/components/storage/restore-runs-dialog";
import { DestinationCombobox } from "@/components/storage/destination-combobox";
import { ScheduleLabel } from "@/components/shared/schedule-picker";
import { BackupScheduleFields } from "@/components/storage/backup-schedule-fields";
import { timeAgo } from "@/lib/utils";
import { useOptimisticRow } from "@/components/shared/optimistic-list";
import { gqlAction } from "@/lib/graphql-client";
import { isValidSchedule } from "@/lib/schedule";
import type { BackupDTO } from "@/lib/data/backups";
import type { DestinationOption } from "@/lib/data/destinations";

type Destination = DestinationOption;

export function BackupRow({
  backup,
  destinations,
  canManage,
  canRestore,
  canTestDestinations,
}: {
  backup: BackupDTO;
  destinations: Destination[];
  /** `manage_backups`. Gates run / edit / delete and the enable switch. */
  canManage: boolean;
  /** `restore_backups`. Restore is the destructive one and has its own. */
  canRestore: boolean;
  /** `manage_backup_destinations`, for the picker's live probe. */
  canTestDestinations: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  // The schedule row leaves the table on the click; deleting one is a single
  // control-plane write with nothing on a host to wait for.
  const { hide, restore } = useOptimisticRow(backup.id);
  const [restoreOpen, setRestoreOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);

  const isApp = backup.targetKind === "app";
  const targetName = isApp ? backup.serviceName : backup.databaseName;
  const targetId = isApp ? backup.appId : backup.databaseId;

  // The mutation resolves at the END of the dump (minutes), so the toast is the
  // RESULT. What says "it started" is the row itself going `running`, which the
  // refresh below brings in within seconds and keeps up to date.
  const [running, setRunning] = React.useState(false);
  /** In flight from here, or already running (this or another tab, or the
   *  scheduler) according to the last read of the schedule. */
  const isRunning = running || backup.lastStatus === "running";

  function run() {
    setRunning(true);
    void gqlAction(`mutation($id: String!) { runBackup(id: $id) }`, {
      id: backup.id,
    }).then((res) => {
      setRunning(false);
      if (res.ok) toast.success("Backup finished");
      else toast.error(res.error);
      router.refresh();
    });
  }

  function toggle(enabled: boolean) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $enabled: Boolean!) { toggleBackup(id: $id, enabled: $enabled) }`,
        { id: backup.id, enabled },
      );
      if (!res.ok) toast.error(res.error);
      else router.refresh();
    });
  }

  const row = (
    <TableRow>
      {/* A dump takes minutes and nothing here changes by itself: re-read the
          page while this one runs, wherever it was started from. */}
      <AutoRefresh active={isRunning} />
      <TableCell className="font-medium">{backup.name}</TableCell>
      <TableCell className="text-muted-foreground">
        <span className="flex items-center gap-1.5">
          {isApp ? (
            <Boxes className="size-3.5 shrink-0" />
          ) : (
            <DatabaseIcon className="size-3.5 shrink-0" />
          )}
          {targetName ?? <span className="italic">deleted</span>}
        </span>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {backup.destinationName}
      </TableCell>
      <TableCell>
        <ScheduleLabel cron={backup.schedule} timezone={backup.timezone} />
      </TableCell>
      <TableCell className="text-muted-foreground">
        {backup.retentionCount}{" "}
        {backup.retentionCount === 1 ? "backup" : "backups"}
      </TableCell>
      <TableCell>
        {backup.lastStatus === "never" ? (
          <span className="text-xs text-muted-foreground">Never run</span>
        ) : backup.lastStatus === "running" ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Running
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs">
            <StatusDot status={backup.lastStatus} />
            {backup.lastRunAt ? timeAgo(backup.lastRunAt) : ""}
          </span>
        )}
      </TableCell>
      <TableCell>
        <Switch
          checked={backup.enabled}
          onCheckedChange={toggle}
          disabled={pending || !canManage}
        />
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Backup menu">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {/* Each item carries a native `title` (via tooltip) so hovering it
                explains what it does. "Run now" is disabled while a mutation is
                in flight; delete confirms before removing. */}
            {/**
             * Disabled rather than hidden, with the reason in the tooltip: a member who cannot
             * act should still see that the action exists and learn which permission to ask
             * for.
             */}
            <SimpleTooltip
              content={
                !canManage
                  ? "You don't have permission to run backups"
                  : isRunning
                    ? "This backup is already running"
                    : "Run this backup now"
              }
              side="left"
            >
              <DropdownMenuItem
                onSelect={run}
                disabled={pending || isRunning || !canManage}
              >
                <Play className="size-4" />
                Run now
              </DropdownMenuItem>
            </SimpleTooltip>
            <SimpleTooltip
              content={
                canManage
                  ? "Edit this backup schedule"
                  : "You don't have permission to edit backup schedules"
              }
              side="left"
            >
              <DropdownMenuItem
                disabled={!canManage}
                onSelect={() => setEditOpen(true)}
              >
                <Pencil className="size-4" />
                Edit
              </DropdownMenuItem>
            </SimpleTooltip>
            <SimpleTooltip
              content={
                canRestore
                  ? "Restore from a recent backup"
                  : "You don't have permission to restore backups"
              }
              side="left"
            >
              <DropdownMenuItem
                disabled={!canRestore}
                onSelect={() => setRestoreOpen(true)}
              >
                <RotateCcw className="size-4" />
                Restore
              </DropdownMenuItem>
            </SimpleTooltip>
            <DropdownMenuSeparator />
            <SimpleTooltip
              content={
                canManage
                  ? "Delete this backup schedule"
                  : "You don't have permission to delete backup schedules"
              }
              side="left"
            >
              <DropdownMenuItem
                variant="destructive"
                disabled={!canManage}
                onSelect={() => setConfirmOpen(true)}
              >
                <Trash2 className="size-4" />
                Delete
              </DropdownMenuItem>
            </SimpleTooltip>
          </DropdownMenuContent>
        </DropdownMenu>
        <ConfirmAction
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Delete backup schedule?"
          description={`${backup.name} stops running. Backups it already made are not deleted.`}
          confirmLabel="Delete schedule"
          successMessage="Backup schedule deleted"
          optimistic
          onConfirm={async () => {
            hide();
            const res = await gqlAction(
              `mutation($id: String!) { deleteBackup(id: $id) }`,
              { id: backup.id },
            );
            if (!res.ok) restore();
            router.refresh();
            return res;
          }}
        />
        {/* Restore from a recent run of this schedule's target. */}
        {targetId && (
          <RestoreRunsDialog
            open={restoreOpen}
            onOpenChange={setRestoreOpen}
            targetKind={backup.targetKind}
            targetId={targetId}
            targetName={targetName ?? backup.name}
          />
        )}
        {/* key on `editOpen` so each open remounts the dialog with fresh state
            seeded from the current schedule, no reset effect needed. */}
        <EditBackupDialog
          key={editOpen ? "edit-open" : "edit-closed"}
          backup={backup}
          destinations={destinations}
          canTestDestinations={canTestDestinations}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
      </TableCell>
    </TableRow>
  );

  return row;
}

/* ------------------------------------------------------------------ */
/* Edit a schedule (name / destination / cron / retention)             */
/* ------------------------------------------------------------------ */

/** Edit dialog for an existing schedule. The target it backs up (a database or
 *  project) is fixed at creation, so only these settings are editable here;
 *  `enabled` keeps its own row toggle. */
function EditBackupDialog({
  backup,
  destinations,
  canTestDestinations,
  open,
  onOpenChange,
}: {
  backup: BackupDTO;
  destinations: Destination[];
  canTestDestinations: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // Seeded from the current schedule on mount; the parent remounts this dialog
  // (via `key`) each time it opens, so these initial values are always fresh and
  // a cancelled edit never leaks stale input into the next open.
  const [name, setName] = React.useState(backup.name);
  const [destinationId, setDestinationId] = React.useState(
    backup.destinationId,
  );
  const [schedule, setSchedule] = React.useState(backup.schedule);
  const [timezone, setTimezone] = React.useState(backup.timezone || "UTC");
  const [retention, setRetention] = React.useState(backup.retentionCount);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    // Closes on the click; a refusal reopens it with the fields as typed.
    onOpenChange(false);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $input: UpdateBackupInput!) { updateBackup(id: $id, input: $input) }`,
        {
          id: backup.id,
          input: {
            name,
            destinationId,
            schedule,
            timezone,
            retentionCount: retention,
          },
        },
      );
      if (res.ok) toast.success("Backup schedule updated");
      else {
        onOpenChange(true);
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit schedule</DialogTitle>
          <DialogDescription>
            Change this schedule&apos;s name, destination, frequency and
            retention. The {backup.targetKind === "app" ? "app" : "database"} it
            backs up can&apos;t be changed.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="grid gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-backup-name">Name</Label>
              <Input
                id="edit-backup-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel
                htmlFor="edit-backup-destination"
                info="Where the backups are kept. Each one shows whether Deplo could reach it."
                docs="backups.destinations"
              >
                Destination
              </FieldLabel>
              <DestinationCombobox
                id="edit-backup-destination"
                destinations={destinations}
                value={destinationId}
                onChange={setDestinationId}
                sameDiskServerId={backup.targetServerId}
                sameDiskNoun={backup.targetKind === "app" ? "app" : "database"}
                canProbe={canTestDestinations}
              />
            </div>
            <BackupScheduleFields
              idPrefix="edit-backup"
              schedule={schedule}
              onScheduleChange={setSchedule}
              timezone={timezone}
              onTimezoneChange={setTimezone}
              retention={retention}
              onRetentionChange={setRetention}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                !name.trim() ||
                !destinationId ||
                !isValidSchedule(schedule)
              }
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Save changes"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
