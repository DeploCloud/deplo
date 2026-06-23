"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Play,
  Plus,
  Pencil,
  RotateCcw,
  Trash2,
  Archive,
  Loader2,
  AlertTriangle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  SimpleTooltip,
} from "@/components/ui/tooltip";
import { StatusDot } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EmptyState } from "@/components/shared/empty-state";
import { formatBytes, timeAgo } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { BackupDTO } from "@/lib/data/backups";
import type { BackupRun } from "@/lib/types";

type Destination = { id: string; name: string };

export function ProjectBackups({
  projectId,
  projectName,
  schedules,
  runs,
  destinations,
}: {
  projectId: string;
  projectName: string;
  schedules: BackupDTO[];
  runs: BackupRun[];
  destinations: Destination[];
}) {
  const noDeps = destinations.length === 0;
  const destName = React.useMemo(
    () => new Map(destinations.map((d) => [d.id, d.name] as const)),
    [destinations],
  );

  return (
    <div className="space-y-8">
      {/* Actions: ad-hoc run + schedule editor */}
      <section className="space-y-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-medium">Back up this project</h2>
            <p className="text-xs text-muted-foreground">
              Captures the project&apos;s persistent volumes, files and its
              compose/env snapshot to an S3 destination. Linked databases are
              backed up separately, as databases.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <BackUpNow projectId={projectId} destinations={destinations} />
            <ScheduleBackup projectId={projectId} destinations={destinations} />
          </div>
        </div>

        {noDeps && (
          <p className="text-xs text-muted-foreground">
            Add an S3 destination under Storage → S3 Destinations to enable
            backups.
          </p>
        )}
      </section>

      {/* Schedules */}
      {schedules.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium">Schedules</h2>
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Schedule</TableHead>
                  <TableHead>Retention</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Enabled</TableHead>
                  <TableHead className="text-right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {schedules.map((s) => (
                  <ScheduleRow
                    key={s.id}
                    schedule={s}
                    destinations={destinations}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {/* Artifacts (runs) */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Backup artifacts</h2>
        {runs.length === 0 ? (
          <EmptyState
            icon={Archive}
            title="No backups yet"
            description="Run a backup or set up a schedule — completed runs and their restore points appear here."
          />
        ) : (
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Destination</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <RunRow
                    key={run.id}
                    run={run}
                    projectName={projectName}
                    destinationName={
                      destName.get(run.destinationId) ?? "Unknown destination"
                    }
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Back up now (ad-hoc)                                                 */
/* ------------------------------------------------------------------ */

function BackUpNow({
  projectId,
  destinations,
}: {
  projectId: string;
  destinations: Destination[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [destinationId, setDestinationId] = React.useState(
    destinations[0]?.id ?? "",
  );
  const noDeps = destinations.length === 0;

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($projectId: String!, $destinationId: String!) {
          runProjectBackup(projectId: $projectId, destinationId: $destinationId)
        }`,
        { projectId, destinationId },
      );
      if (res.ok) {
        toast.success("Backup started");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          {noDeps ? (
            <span tabIndex={0}>
              <Button size="sm" variant="outline" disabled>
                <Play className="size-4" />
                Back up now
              </Button>
            </span>
          ) : (
            <DialogTrigger asChild>
              <Button size="sm" variant="outline">
                <Play className="size-4" />
                Back up now
              </Button>
            </DialogTrigger>
          )}
        </TooltipTrigger>
        <TooltipContent>
          {noDeps ? "Add an S3 destination first" : "Run a one-off backup now"}
        </TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Back up now</DialogTitle>
          <DialogDescription>
            Dump this project&apos;s volumes, files and compose/env snapshot to S3
            immediately — no schedule needed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label>Destination</Label>
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
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !destinationId}>
            {pending ? "Starting…" : "Start backup"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Schedule a project backup                                           */
/* ------------------------------------------------------------------ */

function ScheduleBackup({
  projectId,
  destinations,
}: {
  projectId: string;
  destinations: Destination[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [fields, setFields] = React.useState<ScheduleFields>({
    name: "",
    destinationId: destinations[0]?.id ?? "",
    schedule: "0 3 * * *",
    retention: 14,
  });
  const noDeps = destinations.length === 0;

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: CreateBackupInput!) { createBackup(input: $input) }`,
        {
          input: {
            name: fields.name,
            targetKind: "project",
            projectId,
            destinationId: fields.destinationId,
            schedule: fields.schedule,
            retentionDays: fields.retention,
          },
        },
      );
      if (res.ok) {
        toast.success("Backup schedule created");
        setOpen(false);
        setFields((f) => ({ ...f, name: "" }));
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          {noDeps ? (
            <span tabIndex={0}>
              <Button size="sm" disabled>
                <Plus className="size-4" />
                New schedule
              </Button>
            </span>
          ) : (
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4" />
                New schedule
              </Button>
            </DialogTrigger>
          )}
        </TooltipTrigger>
        <TooltipContent>
          {noDeps ? "Add an S3 destination first" : "Schedule recurring backups"}
        </TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule a backup</DialogTitle>
          <DialogDescription>
            Periodically back up this project to an S3 destination.
          </DialogDescription>
        </DialogHeader>
        <ScheduleFormFields
          fields={fields}
          onChange={setFields}
          destinations={destinations}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !fields.name.trim() || !fields.destinationId}
          >
            {pending ? "Creating…" : "Create schedule"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Edit a project backup schedule                                      */
/* ------------------------------------------------------------------ */

/** The editable settings of a schedule, shared by the create and edit forms. */
type ScheduleFields = {
  name: string;
  destinationId: string;
  schedule: string;
  retention: number;
};

function ScheduleFormFields({
  fields,
  onChange,
  destinations,
}: {
  fields: ScheduleFields;
  onChange: React.Dispatch<React.SetStateAction<ScheduleFields>>;
  destinations: Destination[];
}) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>Name</Label>
        <Input
          value={fields.name}
          onChange={(e) => onChange((f) => ({ ...f, name: e.target.value }))}
          placeholder="Nightly project backup"
        />
      </div>
      <div className="space-y-2">
        <Label>Destination</Label>
        <Select
          value={fields.destinationId}
          onValueChange={(v) => onChange((f) => ({ ...f, destinationId: v }))}
        >
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
          <SimpleTooltip content="Standard cron expression (UTC)">
            <Label className="cursor-help underline decoration-dotted underline-offset-4">
              Schedule (cron)
            </Label>
          </SimpleTooltip>
          <Input
            value={fields.schedule}
            onChange={(e) =>
              onChange((f) => ({ ...f, schedule: e.target.value }))
            }
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-2">
          <Label>Retention (days)</Label>
          <Input
            type="number"
            value={fields.retention}
            onChange={(e) =>
              onChange((f) => ({ ...f, retention: Number(e.target.value) || 7 }))
            }
            min={1}
          />
        </div>
      </div>
    </div>
  );
}

function EditScheduleDialog({
  schedule,
  destinations,
  open,
  onOpenChange,
}: {
  schedule: BackupDTO;
  destinations: Destination[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // Seeded from the current schedule on mount; the parent remounts this dialog
  // (via `key`) each time it opens, so these initial values are always fresh and
  // a cancelled edit never leaks stale input into the next open.
  const [fields, setFields] = React.useState<ScheduleFields>({
    name: schedule.name,
    destinationId: schedule.destinationId,
    schedule: schedule.schedule,
    retention: schedule.retentionDays,
  });

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $input: UpdateBackupInput!) { updateBackup(id: $id, input: $input) }`,
        {
          id: schedule.id,
          input: {
            name: fields.name,
            destinationId: fields.destinationId,
            schedule: fields.schedule,
            retentionDays: fields.retention,
          },
        },
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
            Change this schedule&apos;s name, destination, cron and retention. The
            project it backs up can&apos;t be changed.
          </DialogDescription>
        </DialogHeader>
        <ScheduleFormFields
          fields={fields}
          onChange={setFields}
          destinations={destinations}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !fields.name.trim() || !fields.destinationId}
          >
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Schedule row (toggle + run + delete)                                */
/* ------------------------------------------------------------------ */

function ScheduleRow({
  schedule,
  destinations,
}: {
  schedule: BackupDTO;
  destinations: Destination[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);

  function run() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!) { runBackup(id: $id) }`,
        { id: schedule.id },
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
        { id: schedule.id, enabled },
      );
      if (!res.ok) toast.error(res.error);
      else router.refresh();
    });
  }

  return (
    <TableRow>
      <TableCell className="font-medium">{schedule.name}</TableCell>
      <TableCell className="text-muted-foreground">
        {schedule.destinationName}
      </TableCell>
      <TableCell>
        <code className="font-mono text-xs">{schedule.schedule}</code>
      </TableCell>
      <TableCell className="text-muted-foreground">
        {schedule.retentionDays}d
      </TableCell>
      <TableCell>
        {schedule.lastStatus === "never" ? (
          <span className="text-xs text-muted-foreground">Never run</span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs">
            <StatusDot status={schedule.lastStatus} />
            {schedule.lastRunAt ? timeAgo(schedule.lastRunAt) : ""}
          </span>
        )}
      </TableCell>
      <TableCell>
        <Switch
          checked={schedule.enabled}
          onCheckedChange={toggle}
          disabled={pending}
        />
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={run}
            disabled={pending}
            title="Run this backup now"
            aria-label="Run backup now"
          >
            <Play className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setEditOpen(true)}
            title="Edit this schedule"
            aria-label="Edit schedule"
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setConfirmOpen(true)}
            title="Delete this schedule"
            aria-label="Delete schedule"
          >
            <Trash2 className="size-4 text-destructive" />
          </Button>
        </div>
        {/* key on `editOpen` so each open remounts the dialog with fresh state
            seeded from the current schedule — no reset effect needed. */}
        <EditScheduleDialog
          key={editOpen ? "edit-open" : "edit-closed"}
          schedule={schedule}
          destinations={destinations}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
        <ConfirmAction
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Delete ${schedule.name}?`}
          description="This removes the schedule. Existing backup artifacts in your bucket are kept."
          confirmLabel="Delete schedule"
          successMessage="Backup schedule deleted"
          onConfirm={async () => {
            const res = await gqlAction(
              `mutation($id: String!) { deleteBackup(id: $id) }`,
              { id: schedule.id },
            );
            if (res.ok) router.refresh();
            return res;
          }}
        />
      </TableCell>
    </TableRow>
  );
}

/* ------------------------------------------------------------------ */
/* Run row (restore point)                                             */
/* ------------------------------------------------------------------ */

function RunRow({
  run,
  projectName,
  destinationName,
}: {
  run: BackupRun;
  projectName: string;
  destinationName: string;
}) {
  const router = useRouter();
  const [restoreOpen, setRestoreOpen] = React.useState(false);

  return (
    <TableRow>
      <TableCell className="text-sm">
        {timeAgo(run.startedAt)}
        {run.error && (
          <span className="block max-w-xs truncate text-xs text-destructive" title={run.error}>
            {run.error}
          </span>
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">{destinationName}</TableCell>
      <TableCell className="text-muted-foreground">
        {run.status === "success" ? formatBytes(run.sizeBytes) : "—"}
      </TableCell>
      <TableCell>
        {run.status === "running" ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Running
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-xs capitalize">
            <StatusDot status={run.status} />
            {run.status}
          </span>
        )}
      </TableCell>
      <TableCell className="text-right">
        {/* Restore is only meaningful for a completed artifact. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={run.status !== "success"}
          onClick={() => setRestoreOpen(true)}
          title={
            run.status === "success"
              ? "Restore this backup in place"
              : "Only a successful backup can be restored"
          }
        >
          <RotateCcw className="size-4" />
          Restore
        </Button>
        <ConfirmAction
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
          title="Restore this backup?"
          confirmLabel="Restore"
          successMessage="Restore started"
          confirmText={projectName}
          description={
            <span className="flex flex-col gap-2">
              <span className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  This overwrites <strong>{projectName}</strong> in place with the
                  backup from {timeAgo(run.startedAt)}. The project is stopped,
                  its current volumes and files are wiped, and the snapshot is
                  restored — there is downtime and the current state is{" "}
                  <strong>not recoverable</strong>.
                </span>
              </span>
            </span>
          }
          onConfirm={async () => {
            const res = await gqlAction(
              `mutation($runId: String!) { restoreBackup(runId: $runId) }`,
              { runId: run.id },
            );
            if (res.ok) router.refresh();
            return res;
          }}
        />
      </TableCell>
    </TableRow>
  );
}
