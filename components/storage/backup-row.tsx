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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ConfirmAction } from "@/components/shared/confirm-action";
import { RestoreRunsDialog } from "@/components/storage/restore-runs-dialog";
import { timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { BackupDTO } from "@/lib/data/backups";

type Destination = { id: string; name: string };

export function BackupRow({
  backup,
  destinations,
}: {
  backup: BackupDTO;
  destinations: Destination[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [restoreOpen, setRestoreOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);

  const isApp = backup.targetKind === "app";
  const targetName = isApp ? backup.serviceName : backup.databaseName;
  const targetId = isApp ? backup.appId : backup.databaseId;

  function run() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!) { runBackup(id: $id) }`,
        { id: backup.id }
      );
      if (res.ok) {
        toast.success("Backup started");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function toggle(enabled: boolean) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $enabled: Boolean!) { toggleBackup(id: $id, enabled: $enabled) }`,
        { id: backup.id, enabled }
      );
      if (!res.ok) toast.error(res.error);
      else router.refresh();
    });
  }

  const row = (
    <TableRow>
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
        <code className="font-mono text-xs">{backup.schedule}</code>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {backup.retentionDays}d
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
          disabled={pending}
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
            <SimpleTooltip content="Run this backup now" side="left">
              <DropdownMenuItem onSelect={run} disabled={pending}>
                <Play className="size-4" />
                Run now
              </DropdownMenuItem>
            </SimpleTooltip>
            <SimpleTooltip content="Edit this backup schedule" side="left">
              <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                <Pencil className="size-4" />
                Edit…
              </DropdownMenuItem>
            </SimpleTooltip>
            <SimpleTooltip content="Restore from a recent backup" side="left">
              <DropdownMenuItem onSelect={() => setRestoreOpen(true)}>
                <RotateCcw className="size-4" />
                Restore…
              </DropdownMenuItem>
            </SimpleTooltip>
            <DropdownMenuSeparator />
            <SimpleTooltip content="Delete this backup schedule" side="left">
              <DropdownMenuItem
                variant="destructive"
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
          title={`Delete ${backup.name}?`}
          description="This removes the backup schedule. Existing backup files in your bucket are not deleted."
          confirmLabel="Delete schedule"
          successMessage="Backup schedule deleted"
          onConfirm={async () => {
            const res = await gqlAction(
              `mutation($id: String!) { deleteBackup(id: $id) }`,
              { id: backup.id }
            );
            if (res.ok) router.refresh();
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
            seeded from the current schedule — no reset effect needed. */}
        <EditBackupDialog
          key={editOpen ? "edit-open" : "edit-closed"}
          backup={backup}
          destinations={destinations}
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
  open,
  onOpenChange,
}: {
  backup: BackupDTO;
  destinations: Destination[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // Seeded from the current schedule on mount; the parent remounts this dialog
  // (via `key`) each time it opens, so these initial values are always fresh and
  // a cancelled edit never leaks stale input into the next open.
  const [name, setName] = React.useState(backup.name);
  const [destinationId, setDestinationId] = React.useState(backup.destinationId);
  const [schedule, setSchedule] = React.useState(backup.schedule);
  const [retention, setRetention] = React.useState(backup.retentionDays);

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $input: UpdateBackupInput!) { updateBackup(id: $id, input: $input) }`,
        {
          id: backup.id,
          input: { name, destinationId, schedule, retentionDays: retention },
        }
      );
      if (res.ok) {
        toast.success("Backup schedule updated");
        onOpenChange(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit schedule</DialogTitle>
          <DialogDescription>
            Change this schedule&apos;s name, destination, cron and retention. The{" "}
            {backup.targetKind === "app" ? "app" : "database"} it backs up
            can&apos;t be changed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <FieldLabel info="Where backup files are uploaded, chosen from your configured storage destinations.">
              Destination
            </FieldLabel>
            <Select value={destinationId} onValueChange={setDestinationId}>
              <SelectTrigger>
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {destinations.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <FieldLabel info="Standard cron expression (UTC).">
                Schedule (cron)
              </FieldLabel>
              <Input
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-2">
              <FieldLabel info="How many days to keep each backup before it's pruned.">
                Retention (days)
              </FieldLabel>
              <Input
                type="number"
                value={retention}
                onChange={(e) => setRetention(Number(e.target.value) || 7)}
                min={1}
              />
            </div>
          </div>
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
            onClick={submit}
            disabled={pending || !name.trim() || !destinationId}
          >
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
