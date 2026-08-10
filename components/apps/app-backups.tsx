"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Play,
  Plus,
  Pencil,
  RotateCcw,
  Trash2,
  Loader2,
  AlertTriangle,
  Download,
  ArrowUpRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
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
import { BackupGraphic } from "@/components/apps/backup-graphic";
import { formatBytes, timeAgo } from "@/lib/utils";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { ScheduleLabel } from "@/components/shared/schedule-picker";
import {
  BackupScheduleFields,
  browserTimezone,
} from "@/components/storage/backup-schedule-fields";
import { DestinationCombobox } from "@/components/storage/destination-combobox";
import { gqlAction } from "@/lib/graphql-client";
import { DEFAULT_SCHEDULE, isValidSchedule } from "@/lib/schedule";
import type { BackupDTO } from "@/lib/data/backups";
import type { DestinationOption } from "@/lib/data/destinations";
import type { BackupRun } from "@/lib/types";

type Destination = DestinationOption;

export function AppBackups({
  appId,
  serviceName,
  serverId,
  schedules,
  runs,
  destinations,
  canTestDestinations,
}: {
  appId: string;
  serviceName: string;
  /** The server this app runs on. Passed to every destination picker so that
   *  CHOOSING a destination on that same disk says so — a copy, not a second
   *  place. Nothing is said while the choice isn't being made. */
  serverId: string | null;
  schedules: BackupDTO[];
  runs: BackupRun[];
  destinations: Destination[];
  /** Whether this user may run the live connection probe the picker fires. */
  canTestDestinations: boolean;
}) {
  const noDeps = destinations.length === 0;
  const destName = React.useMemo(
    () => new Map(destinations.map((d) => [d.id, d.name] as const)),
    [destinations],
  );
  const destKind = React.useMemo(
    () => new Map(destinations.map((d) => [d.id, d.kind] as const)),
    [destinations],
  );

  // A dump runs on the host for minutes with nothing on this page changing by
  // itself. Count what is in flight - the runs the server says are `running`,
  // plus the ones started from THIS page that have not written their row yet -
  // and let `AutoRefresh` re-read the page for exactly that long.
  const [starting, setStarting] = React.useState(0);
  const track = React.useCallback((p: Promise<unknown>) => {
    setStarting((n) => n + 1);
    void p.finally(() => setStarting((n) => n - 1));
  }, []);
  const anythingRunning =
    starting > 0 ||
    runs.some((r) => r.status === "running") ||
    schedules.some((s) => s.lastStatus === "running");

  return (
    <div className="space-y-8">
      <AutoRefresh active={anythingRunning} />
      {/* Actions: ad-hoc run + schedule editor */}
      <section className="space-y-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-medium">Back up this app</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Captures the app&apos;s persistent volumes, files and its
              compose/env snapshot to a backup destination. Linked databases are
              backed up separately, as databases.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <BackUpNow
              appId={appId}
              destinations={destinations}
              serverId={serverId}
              canTestDestinations={canTestDestinations}
              track={track}
            />
            <ScheduleBackup
              appId={appId}
              destinations={destinations}
              serverId={serverId}
              canTestDestinations={canTestDestinations}
            />
          </div>
        </div>
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
                    serverId={serverId}
                    canTestDestinations={canTestDestinations}
                    track={track}
                  />
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {/* No destination yet — backups have nowhere to go without one. This
          sits right above the artifacts so the empty state is explained, with a
          link straight to Storage → Destinations (dialog pre-opened). */}
      {noDeps && (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-4 sm:flex-row sm:items-center">
          <AlertTriangle className="size-5 shrink-0 text-[var(--warning)]" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">No backup destination configured</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a server to keep backups on, or connect an S3 bucket, and
              backups can run — completed artifacts then appear here.
            </p>
          </div>
          <Button asChild size="sm" className="shrink-0 sm:ml-auto">
            <Link href="/storage?new=destination">
              Add destination
              <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        </div>
      )}

      {/* Artifacts (runs) */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium">Backup artifacts</h2>
        {runs.length === 0 ? (
          <EmptyState
            graphic={<BackupGraphic />}
            title="No backups yet"
            description="Run a backup or set up a schedule - completed runs and their restore points appear here."
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
                    serviceName={serviceName}
                    destinationName={
                      destName.get(run.destinationId) ?? "Unknown destination"
                    }
                    downloadable={destKind.get(run.destinationId) === "server"}
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
  appId,
  destinations,
  serverId,
  canTestDestinations,
  track,
}: {
  appId: string;
  destinations: Destination[];
  serverId: string | null;
  canTestDestinations: boolean;
  /** Keeps the page auto-refreshing until this backup lands. */
  track: (p: Promise<unknown>) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [destinationId, setDestinationId] = React.useState(
    destinations[0]?.id ?? "",
  );
  const noDeps = destinations.length === 0;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    // The mutation runs the WHOLE dump - it resolves only once the archive is
    // written. So the dialog closes now and the artifact shows up in the table
    // as a real `running` row (the executor records it before it starts), which
    // the page's AutoRefresh brings in within seconds and updates in place.
    setOpen(false);
    track(
      gqlAction(
        `mutation($appId: String!, $destinationId: String!) {
          runAppBackup(appId: $appId, destinationId: $destinationId)
        }`,
        { appId, destinationId },
      ).then((res) => {
        if (res.ok) toast.success("Backup finished");
        else {
          toast.error(res.error);
          setOpen(true);
        }
        router.refresh();
      }),
    );
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
          {noDeps ? "Add a backup destination first" : "Run a one-off backup now"}
        </TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Back up now</DialogTitle>
          <DialogDescription>
            Dump this app&apos;s volumes, files and compose/env snapshot to a
            destination now - no schedule needed.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="backup-now-destination"
              info="Where this backup is written. Each one shows whether Deplo could reach it."
            >
              Destination
            </FieldLabel>
            <DestinationCombobox
              id="backup-now-destination"
              destinations={destinations}
              value={destinationId}
              onChange={setDestinationId}
              sameDiskServerId={serverId}
              canProbe={canTestDestinations}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!destinationId}>
              Start backup
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Schedule an app backup                                              */
/* ------------------------------------------------------------------ */

function ScheduleBackup({
  appId,
  destinations,
  serverId,
  canTestDestinations,
}: {
  appId: string;
  destinations: Destination[];
  serverId: string | null;
  canTestDestinations: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [fields, setFields] = React.useState<ScheduleFields>(() => ({
    name: "",
    destinationId: destinations[0]?.id ?? "",
    schedule: DEFAULT_SCHEDULE,
    timezone: browserTimezone(),
    retention: 14,
  }));
  const noDeps = destinations.length === 0;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: CreateBackupInput!) { createBackup(input: $input) }`,
        {
          input: {
            name: fields.name,
            targetKind: "app",
            appId,
            destinationId: fields.destinationId,
            schedule: fields.schedule,
            timezone: fields.timezone,
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
          {noDeps ? "Add a backup destination first" : "Schedule recurring backups"}
        </TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Schedule a backup</DialogTitle>
          <DialogDescription>
            Periodically back up this app to a backup destination.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <ScheduleFormFields
            fields={fields}
            onChange={setFields}
            destinations={destinations}
            serverId={serverId}
            canTestDestinations={canTestDestinations}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                !fields.name.trim() ||
                !fields.destinationId ||
                !isValidSchedule(fields.schedule)
              }
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : "Create schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */
/* Edit an app backup schedule                                         */
/* ------------------------------------------------------------------ */

/** The editable settings of a schedule, shared by the create and edit forms. */
type ScheduleFields = {
  name: string;
  destinationId: string;
  schedule: string;
  timezone: string;
  retention: number;
};

function ScheduleFormFields({
  fields,
  onChange,
  destinations,
  serverId,
  canTestDestinations,
}: {
  fields: ScheduleFields;
  onChange: React.Dispatch<React.SetStateAction<ScheduleFields>>;
  destinations: Destination[];
  /** This app's server, so the destination picker can flag a same-disk pick. */
  serverId: string | null;
  canTestDestinations: boolean;
}) {
  return (
    <div className="grid gap-4">
      <div className="space-y-2">
        <Label htmlFor="app-backup-name">Name</Label>
        <Input
          id="app-backup-name"
          value={fields.name}
          onChange={(e) => onChange((f) => ({ ...f, name: e.target.value }))}
          placeholder="Nightly project backup"
        />
      </div>
      <div className="space-y-2">
        <FieldLabel
          htmlFor="app-backup-destination"
          info="Where scheduled backups are written. Each one shows whether Deplo could reach it."
        >
          Destination
        </FieldLabel>
        <DestinationCombobox
          id="app-backup-destination"
          destinations={destinations}
          value={fields.destinationId}
          onChange={(v) => onChange((f) => ({ ...f, destinationId: v }))}
          sameDiskServerId={serverId}
          canProbe={canTestDestinations}
        />
      </div>
      <BackupScheduleFields
        idPrefix="app-backup"
        schedule={fields.schedule}
        onScheduleChange={(cron) => onChange((f) => ({ ...f, schedule: cron }))}
        timezone={fields.timezone}
        onTimezoneChange={(tz) => onChange((f) => ({ ...f, timezone: tz }))}
        retention={fields.retention}
        onRetentionChange={(days) => onChange((f) => ({ ...f, retention: days }))}
      />
    </div>
  );
}

function EditScheduleDialog({
  schedule,
  destinations,
  serverId,
  canTestDestinations,
  open,
  onOpenChange,
}: {
  schedule: BackupDTO;
  destinations: Destination[];
  serverId: string | null;
  canTestDestinations: boolean;
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
    timezone: schedule.timezone || "UTC",
    retention: schedule.retentionDays,
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

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
            timezone: fields.timezone,
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
        <form className="grid gap-4" onSubmit={onSubmit}>
          <ScheduleFormFields
            fields={fields}
            onChange={setFields}
            destinations={destinations}
            serverId={serverId}
            canTestDestinations={canTestDestinations}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending ||
                !fields.name.trim() ||
                !fields.destinationId ||
                !isValidSchedule(fields.schedule)
              }
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
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
  serverId,
  canTestDestinations,
  track,
}: {
  schedule: BackupDTO;
  destinations: Destination[];
  serverId: string | null;
  canTestDestinations: boolean;
  /** Keeps the page auto-refreshing until this run lands. */
  track: (p: Promise<unknown>) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [editOpen, setEditOpen] = React.useState(false);

  function run() {
    // Resolves at the END of the dump, so the toast is the RESULT - the row goes
    // `running` on its own within a tick of AutoRefresh, which is the feedback
    // that the backup started.
    track(
      gqlAction(`mutation($id: String!) { runBackup(id: $id) }`, {
        id: schedule.id,
      }).then((res) => {
        if (res.ok) toast.success("Backup finished");
        else toast.error(res.error);
        router.refresh();
      }),
    );
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
        <ScheduleLabel cron={schedule.schedule} timezone={schedule.timezone} />
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
          <SimpleTooltip
            content={
              schedule.lastStatus === "running"
                ? "This backup is already running"
                : "Run this backup now"
            }
          >
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={run}
              // A run in flight - started here, from Storage, or by the
              // scheduler - is visible in the row, so the button says so
              // instead of letting a second dump start on top of it.
              disabled={pending || schedule.lastStatus === "running"}
              aria-label="Run backup now"
            >
              <Play className="size-4" />
            </Button>
          </SimpleTooltip>
          <SimpleTooltip content="Edit this schedule">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setEditOpen(true)}
              aria-label="Edit schedule"
            >
              <Pencil className="size-4" />
            </Button>
          </SimpleTooltip>
          <SimpleTooltip content="Delete this schedule">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setConfirmOpen(true)}
              aria-label="Delete schedule"
            >
              <Trash2 className="size-4 text-destructive" />
            </Button>
          </SimpleTooltip>
        </div>
        {/* key on `editOpen` so each open remounts the dialog with fresh state
            seeded from the current schedule — no reset effect needed. */}
        <EditScheduleDialog
          key={editOpen ? "edit-open" : "edit-closed"}
          schedule={schedule}
          destinations={destinations}
          serverId={serverId}
          canTestDestinations={canTestDestinations}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
        <ConfirmAction
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Delete ${schedule.name}?`}
          description="This removes the schedule. Backups it already made are kept."
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
  serviceName,
  destinationName,
  downloadable,
}: {
  run: BackupRun;
  serviceName: string;
  destinationName: string;
  /** Whether this run's artifact is on a server we can stream it from. An S3
   *  artifact is not offered here: pulling it out of the bucket and back through
   *  Deplo would double the transfer to hand over a file the operator can
   *  already fetch with their own credentials. */
  downloadable: boolean;
}) {
  const router = useRouter();
  const [restoreOpen, setRestoreOpen] = React.useState(false);

  return (
    <TableRow>
      <TableCell className="text-sm">
        {timeAgo(run.startedAt)}
        {run.error && (
          <SimpleTooltip content={run.error}>
            <span className="block max-w-xs truncate text-xs text-destructive">
              {run.error}
            </span>
          </SimpleTooltip>
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
        {/* See RestoreRunsDialog: only the runs from before checksums say so. */}
        {run.status === "success" && !run.sha256 && (
          <SimpleTooltip content="Taken before Deplo recorded checksums, so it cannot prove this file is unchanged">
            <span className="mt-1 block text-[10px] text-muted-foreground">
              Not checksummed
            </span>
          </SimpleTooltip>
        )}
      </TableCell>
      <TableCell className="text-right">
        {/* The file itself, decrypted. The reason a folder on your own server is
            worth having: the backup is a thing you can hold, not only a thing
            Deplo can put back. */}
        {downloadable && (
          <SimpleTooltip
            content={
              run.status === "success"
                ? "Download this backup file"
                : "Only a successful backup can be downloaded"
            }
          >
            <Button
              variant="ghost"
              size="sm"
              asChild={run.status === "success"}
              disabled={run.status !== "success"}
            >
              {run.status === "success" ? (
                <a href={`/api/backups/${run.id}/download`} download>
                  <Download className="size-4" />
                  Download
                </a>
              ) : (
                <span>
                  <Download className="size-4" />
                  Download
                </span>
              )}
            </Button>
          </SimpleTooltip>
        )}
        {/* Restore is only meaningful for a completed artifact. */}
        <SimpleTooltip
          content={
            run.status === "success"
              ? "Restore this backup in place"
              : "Only a successful backup can be restored"
          }
        >
          <Button
            variant="ghost"
            size="sm"
            disabled={run.status !== "success"}
            onClick={() => setRestoreOpen(true)}
          >
            <RotateCcw className="size-4" />
            Restore
          </Button>
        </SimpleTooltip>
        <ConfirmAction
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
          title="Restore this backup?"
          confirmLabel="Restore"
          successMessage="Restore started"
          confirmText={serviceName}
          description={
            <span className="flex flex-col gap-2">
              <span className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  This overwrites <strong>{serviceName}</strong> in place with the
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
