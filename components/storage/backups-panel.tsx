"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Archive,
  ArrowUpRight,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Download,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { AnimatedHeight } from "@/components/shared/animated-height";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EmptyState } from "@/components/shared/empty-state";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import { BackupGraphic } from "@/components/apps/backup-graphic";
import { cn, formatBytes, timeAgo } from "@/lib/utils";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { ScheduleLabel } from "@/components/shared/schedule-picker";
import {
  BackupScheduleFields,
  DEFAULT_RETENTION,
  browserTimezone,
  suggestScheduleName,
} from "@/components/storage/backup-schedule-fields";
import { DestinationCombobox } from "@/components/storage/destination-combobox";
import { RecoveryKeyNudge } from "@/components/storage/recovery-key";
import { RestoreFromFile } from "@/components/storage/restore-from-file";
import {
  OptimisticList,
  useOptimisticRow,
} from "@/components/shared/optimistic-list";
import { gqlAction } from "@/lib/graphql-client";
import { DEFAULT_SCHEDULE, isValidSchedule } from "@/lib/schedule";
import type { BackupDTO } from "@/lib/data/backups";
import type { DestinationOption } from "@/lib/data/destinations";
import type { BackupRun } from "@/lib/types";

type Destination = DestinationOption;

/** What this panel backs up: one app, or one database. */
export interface BackupTarget {
  kind: "app" | "database";
  id: string;
  name: string;
  /** The server it runs on - every destination picker flags a destination that
   *  sits on that same disk. Null when the target's server is unknown. */
  serverId: string | null;
}

/** The noun for this target, for the sentences that have to name it. */
const noun = (t: BackupTarget) => (t.kind === "app" ? "app" : "database");

/** What a backup of this target actually captures, in one line. */
function capturedBlurb(target: BackupTarget): string {
  return target.kind === "app"
    ? "Captures the app's persistent volumes, files and its compose/env snapshot to a backup destination. Linked databases are backed up separately, as databases."
    : `Captures a full dump of ${target.name} to a backup destination, ready to restore from any run.`;
}

/**
 * The Backups tab - schedules, one-off runs, and the artifacts they produced.
 */
export function BackupsPanel({
  target,
  schedules,
  runs,
  destinations,
  canManage,
  canRestore,
  canDelete,
  canTestDestinations,
}: {
  target: BackupTarget;
  schedules: BackupDTO[];
  runs: BackupRun[];
  destinations: Destination[];
  /** `manage_backups` - schedule, run, edit, delete. */
  canManage: boolean;
  /** `restore_backups` - its own, because a restore overwrites live data (and
   *  a download hands over every byte, which is the same power). */
  canRestore: boolean;
  /** `delete_backups` - its own capability, and the only irreversible one on
   *  this screen: the artifact is the last copy of that moment. */
  canDelete: boolean;
  /** `manage_backup_destinations`: whether this user may run the live connection
   *  probe the picker fires, and take a destination's recovery key. */
  canTestDestinations: boolean;
}) {
  const router = useRouter();
  const noDeps = destinations.length === 0;
  const destName = React.useMemo(
    () => new Map(destinations.map((d) => [d.id, d.name] as const)),
    [destinations],
  );

  // A dump runs on the host for minutes with nothing on this page changing by itself,
  // and the mutation that started it only resolves at the very END.
  const [pending, setPending] = React.useState<
    { id: number; destinationId: string; baseline: number }[]
  >([]);
  const runningNow = runs.filter((r) => r.status === "running").length;
  // Retire a placeholder the moment a real `running` row shows up above the count
  // that stood when it was created: the swap happens in one commit, so there is never
  // a duplicate.
  const [seenRunning, setSeenRunning] = React.useState(runningNow);
  if (runningNow !== seenRunning) {
    setSeenRunning(runningNow);
    if (pending.some((x) => runningNow > x.baseline))
      setPending((p) => p.filter((x) => runningNow <= x.baseline));
  }

  const nextPendingId = React.useRef(0);
  const startRun = React.useCallback(
    (destinationId: string, run: () => Promise<unknown>) => {
      const id = nextPendingId.current++;
      // `runningNow` as of this render is the baseline: "has MY row landed yet?"
      // is answerable by the count alone, and the run's real id does not exist
      // on this side until the dump finishes.
      setPending((p) => [...p, { id, destinationId, baseline: runningNow }]);
      void run().finally(() => setPending((p) => p.filter((x) => x.id !== id)));
    },
    [runningNow],
  );

  const anythingRunning =
    pending.length > 0 ||
    runningNow > 0 ||
    schedules.some((s) => s.lastStatus === "running");

  // Destinations this target already writes to, whose artifacts are encrypted and
  // whose key nobody has taken.
  const unsavedKeyDestinations = React.useMemo(() => {
    if (!canTestDestinations) return [];
    const used = new Set([
      ...schedules.map((s) => s.destinationId),
      ...runs.map((r) => r.destinationId),
    ]);
    return destinations.filter(
      (d) => used.has(d.id) && d.encrypted && !d.recoveryKeySavedAt,
    );
  }, [canTestDestinations, schedules, runs, destinations]);

  return (
    <div className="space-y-8">
      {/* Faster while a run started here has not surfaced yet: that gap is the
          one the placeholder is covering, and the sooner the real row lands the
          shorter it is. */}
      <AutoRefresh
        active={anythingRunning}
        intervalMs={pending.length > 0 ? 2_000 : 5_000}
      />
      {/**
       * The recovery key, asked for where the backups actually are. Only the destinations
       * THIS target writes to, so a page for one app never nags about a bucket it has
       * nothing to do with.
       */}
      {unsavedKeyDestinations.map((d) => (
        <RecoveryKeyNudge
          key={d.id}
          destinationId={d.id}
          title={`Save the recovery key for ${d.name}`}
          description="These backups are encrypted. Without this key they cannot be read if you lose this instance."
          onSaved={() => router.refresh()}
        />
      ))}
      {/* Actions: ad-hoc run + schedule editor */}
      <section className="space-y-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-sm font-medium">Back up this {noun(target)}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {capturedBlurb(target)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <BackUpNow
              target={target}
              destinations={destinations}
              canManage={canManage}
              canTestDestinations={canTestDestinations}
              onStart={startRun}
            />
            {/* Deliberately here even when there is no destination at all: this
                is the one restore that needs nothing this instance remembers,
                and the operator reaching for it has usually just lost the rest. */}
            <RestoreFromFile target={target} canRestore={canRestore} />
            <ScheduleBackup
              target={target}
              destinations={destinations}
              canManage={canManage}
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
                {/* A deleted schedule leaves the table on the click - see
                    `OptimisticList`; the rows ask to be hidden themselves. */}
                <OptimisticList>
                  {schedules.map((s) => (
                    <ScheduleRow
                      key={s.id}
                      schedule={s}
                      target={target}
                      destinations={destinations}
                      canManage={canManage}
                      canTestDestinations={canTestDestinations}
                      onStart={startRun}
                    />
                  ))}
                </OptimisticList>
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {/* No destination yet - backups have nowhere to go without one. This
          sits right above the artifacts so the empty state is explained, with a
          link straight to Storage → Destinations (dialog pre-opened). */}
      {noDeps && (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-4 sm:flex-row sm:items-center">
          <AlertTriangle className="size-5 shrink-0 text-[var(--warning)]" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              No backup destination configured
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick a server to keep backups on, or connect an S3 bucket, and
              backups can run - completed artifacts then appear here.
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
        {runs.length === 0 && pending.length === 0 ? (
          <EmptyState
            graphic={<BackupGraphic />}
            title="No backups yet"
            docs="backups.schedule"
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
                {pending.map((p) => (
                  <PendingRunRow
                    key={p.id}
                    destinationName={
                      destName.get(p.destinationId) ?? "Unknown destination"
                    }
                    canRestore={canRestore}
                  />
                ))}
                <OptimisticList>
                  {runs.map((run) => (
                    <RunRow
                      key={run.id}
                      run={run}
                      target={target}
                      canRestore={canRestore}
                      canDelete={canDelete}
                      canManage={canManage}
                      destinationName={
                        destName.get(run.destinationId) ?? "Unknown destination"
                      }
                    />
                  ))}
                </OptimisticList>
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
  target,
  destinations,
  canManage,
  canTestDestinations,
  onStart,
}: {
  target: BackupTarget;
  destinations: Destination[];
  canManage: boolean;
  canTestDestinations: boolean;
  /** Puts a placeholder row on the page and keeps it refreshing until this
   *  backup lands. */
  onStart: (destinationId: string, run: () => Promise<unknown>) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [destinationId, setDestinationId] = React.useState(
    destinations[0]?.id ?? "",
  );
  const blocked = !canManage
    ? "You don't have permission to run backups"
    : destinations.length === 0
      ? "Add a backup destination first"
      : null;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    // The mutation runs the WHOLE dump - it resolves only once the archive is written.
    setOpen(false);
    const mutation =
      target.kind === "app"
        ? `mutation($id: String!, $destinationId: String!) {
             runAppBackup(appId: $id, destinationId: $destinationId)
           }`
        : `mutation($id: String!, $destinationId: String!) {
             runDatabaseBackup(databaseId: $id, destinationId: $destinationId)
           }`;
    onStart(destinationId, () =>
      gqlAction(mutation, { id: target.id, destinationId }).then((res) => {
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
          {blocked ? (
            // Disabled buttons swallow pointer events, so wrap in a focusable
            // span to keep the tooltip reachable.
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
        <TooltipContent>{blocked ?? "Run a one-off backup now"}</TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Back up now</DialogTitle>
          <DialogDescription>
            {target.kind === "app"
              ? "Dump this app's volumes, files and compose/env snapshot to a destination now - no schedule needed."
              : "Dump this database to a destination now - no schedule needed."}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <FieldLabel
              htmlFor="backup-now-destination"
              info="Where this backup is written. Each one shows whether Deplo could reach it."
              docs="backups.destinations"
            >
              Destination
            </FieldLabel>
            <DestinationCombobox
              id="backup-now-destination"
              destinations={destinations}
              value={destinationId}
              onChange={setDestinationId}
              sameDiskServerId={target.serverId}
              sameDiskNoun={noun(target)}
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
/* Schedule a backup                                                   */
/* ------------------------------------------------------------------ */

/** The editable settings of a schedule, shared by the create and edit forms. */
type ScheduleFields = {
  name: string;
  destinationId: string;
  schedule: string;
  timezone: string;
  retention: number;
};

type StepId = "destination" | "schedule";

const STEPS: { id: StepId; label: string }[] = [
  { id: "destination", label: "Destination" },
  { id: "schedule", label: "Schedule" },
];

/** Per-step heading, icon and one line of orientation. Same wording as the
 *  Storage wizard, minus its first step: here the target is the page. */
const STEP_COPY: Record<
  StepId,
  {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    blurb: string;
  }
> = {
  destination: {
    icon: Archive,
    title: "Where should it go?",
    blurb:
      "A folder on one of your servers, or any S3 bucket. Each one shows whether Deplo could reach it.",
  },
  schedule: {
    icon: CalendarClock,
    title: "When should it run?",
    blurb:
      "Pick how often, and how many backups to keep. Older ones are removed after each successful run.",
  },
};

/**
 * Schedule a backup of THIS app or database - the Storage wizard without its first
 * step, because the page already answers what is being backed up.
 */
function ScheduleBackup({
  target,
  destinations,
  canManage,
  canTestDestinations,
}: {
  target: BackupTarget;
  destinations: Destination[];
  canManage: boolean;
  canTestDestinations: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [step, setStep] = React.useState<StepId>("destination");
  // The name follows the frequency until the user types their own.
  const [nameTouched, setNameTouched] = React.useState(false);
  const [fields, setFields] = React.useState<ScheduleFields>(() => ({
    name: suggestScheduleName(DEFAULT_SCHEDULE),
    destinationId: destinations[0]?.id ?? "",
    schedule: DEFAULT_SCHEDULE,
    timezone: browserTimezone(),
    retention: DEFAULT_RETENTION,
  }));
  const blocked = !canManage
    ? "You don't have permission to schedule backups"
    : destinations.length === 0
      ? "Add a backup destination first"
      : null;

  /** What each step needs before the next one means anything. */
  const complete: Record<StepId, boolean> = {
    destination: !!fields.destinationId,
    schedule: !!fields.name.trim() && isValidSchedule(fields.schedule),
  };
  const index = STEPS.findIndex((s) => s.id === step);
  const { icon: StepIcon, title, blurb } = STEP_COPY[step];

  function close() {
    setOpen(false);
    // Deferred so the close animation does not play over a form that has
    // already snapped back to step one.
    setTimeout(() => setStep("destination"), 200);
  }

  /** Enter runs whatever the current step's primary button does. */
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending || !complete[step]) return;
    if (step === "schedule") submit();
    else setStep(STEPS[index + 1]!.id);
  }

  function submit() {
    // Closes on the click and writes behind it; a refusal reopens the wizard
    // with the destination and schedule still filled in.
    setOpen(false);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: CreateBackupInput!) { createBackup(input: $input) }`,
        {
          input: {
            name: fields.name,
            targetKind: target.kind,
            appId: target.kind === "app" ? target.id : null,
            databaseId: target.kind === "database" ? target.id : null,
            destinationId: fields.destinationId,
            schedule: fields.schedule,
            timezone: fields.timezone,
            retentionCount: fields.retention,
          },
        },
      );
      if (res.ok) {
        toast.success("Backup schedule created");
        close();
      } else {
        setOpen(true);
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <Tooltip>
        <TooltipTrigger asChild>
          {blocked ? (
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
          {blocked ?? "Schedule recurring backups"}
        </TooltipContent>
      </Tooltip>
      {/* `selfManaged`: the step box below animates its own height and has to be
          free to overflow, so a combobox menu can hang past its field. */}
      <DialogContent selfManaged className="sm:max-w-lg">
        <DialogHeader className="space-y-0 pr-8">
          <DialogTitle className="sr-only">Schedule a backup</DialogTitle>
          <DialogDescription className="sr-only">
            Periodically back up this {noun(target)} to a backup destination, in
            two steps.
          </DialogDescription>
          <WizardStepper
            steps={STEPS}
            current={step}
            reachable={(s) =>
              STEPS.slice(
                0,
                STEPS.findIndex((x) => x.id === s),
              ).every((x) => complete[x.id])
            }
            onSelect={setStep}
          />
        </DialogHeader>

        <form className="grid gap-4" onSubmit={onSubmit}>
          <AnimatedHeight className="mx-auto flex w-full max-w-md flex-col gap-5 py-2">
            {/* One heading block, same shape on every step, so the eye lands in
                the same place each time the body swaps under it. */}
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                <StepIcon className="size-5 text-primary" />
              </span>
              <h2 className="text-base font-semibold lg:text-lg">{title}</h2>
              <p className="text-sm text-balance text-muted-foreground">
                {blurb}
              </p>
            </div>

            {step === "destination" ? (
              <DestinationField
                value={fields.destinationId}
                onChange={(v) => setFields((f) => ({ ...f, destinationId: v }))}
                target={target}
                destinations={destinations}
                canTestDestinations={canTestDestinations}
              />
            ) : (
              <div className="space-y-4">
                <NameField
                  value={fields.name}
                  onChange={(v) => {
                    setNameTouched(true);
                    setFields((f) => ({ ...f, name: v }));
                  }}
                />
                <BackupScheduleFields
                  idPrefix="backup"
                  schedule={fields.schedule}
                  onScheduleChange={(cron) =>
                    setFields((f) => ({
                      ...f,
                      schedule: cron,
                      name: nameTouched ? f.name : suggestScheduleName(cron),
                    }))
                  }
                  timezone={fields.timezone}
                  onTimezoneChange={(tz) =>
                    setFields((f) => ({ ...f, timezone: tz }))
                  }
                  retention={fields.retention}
                  onRetentionChange={(count) =>
                    setFields((f) => ({ ...f, retention: count }))
                  }
                />
              </div>
            )}
          </AnimatedHeight>

          <DialogFooter className="flex-row items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setStep(STEPS[index - 1]!.id)}
              disabled={index === 0 || pending}
              className={cn(index === 0 && "invisible")}
            >
              <ChevronLeft className="size-4" />
              Back
            </Button>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={close}
                disabled={pending}
              >
                Cancel
              </Button>
              {step === "schedule" ? (
                <Button type="submit" disabled={pending || !complete.schedule}>
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    "Create schedule"
                  )}
                </Button>
              ) : (
                <Button type="submit" disabled={!complete.destination}>
                  Continue
                  <ChevronRight className="size-4" />
                </Button>
              )}
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The schedule's name - one field, shared by the wizard's last step and the
 *  edit form, so the two never label or explain it differently. */
function NameField({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor="backup-name"
        info="What this schedule is called in the list. Follows the frequency until you change it."
        docs="backups.schedule"
      >
        Name
      </FieldLabel>
      <Input
        id="backup-name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
      />
    </div>
  );
}

/** Where the archives are written - the wizard's first step, and one row of the
 *  edit form. */
function DestinationField({
  value,
  onChange,
  target,
  destinations,
  canTestDestinations,
}: {
  value: string;
  onChange: (value: string) => void;
  target: BackupTarget;
  destinations: Destination[];
  canTestDestinations: boolean;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor="backup-destination"
        info="Where scheduled backups are written. Each one shows whether Deplo could reach it."
        docs="backups.destinations"
      >
        Destination
      </FieldLabel>
      <DestinationCombobox
        id="backup-destination"
        destinations={destinations}
        value={value}
        onChange={onChange}
        sameDiskServerId={target.serverId}
        sameDiskNoun={noun(target)}
        canProbe={canTestDestinations}
      />
    </div>
  );
}

function EditScheduleDialog({
  schedule,
  target,
  destinations,
  canTestDestinations,
  open,
  onOpenChange,
}: {
  schedule: BackupDTO;
  target: BackupTarget;
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
  const [fields, setFields] = React.useState<ScheduleFields>({
    name: schedule.name,
    destinationId: schedule.destinationId,
    schedule: schedule.schedule,
    timezone: schedule.timezone || "UTC",
    retention: schedule.retentionCount,
  });

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
          id: schedule.id,
          input: {
            name: fields.name,
            destinationId: fields.destinationId,
            schedule: fields.schedule,
            timezone: fields.timezone,
            retentionCount: fields.retention,
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
            retention. The {noun(target)} it backs up can&apos;t be changed.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          {/* No auto-rename here: the name is already the user's own. */}
          <NameField
            value={fields.name}
            onChange={(v) => setFields((f) => ({ ...f, name: v }))}
            autoFocus
          />
          <DestinationField
            value={fields.destinationId}
            onChange={(v) => setFields((f) => ({ ...f, destinationId: v }))}
            target={target}
            destinations={destinations}
            canTestDestinations={canTestDestinations}
          />
          <BackupScheduleFields
            idPrefix="backup"
            schedule={fields.schedule}
            onScheduleChange={(cron) =>
              setFields((f) => ({ ...f, schedule: cron }))
            }
            timezone={fields.timezone}
            onTimezoneChange={(tz) =>
              setFields((f) => ({ ...f, timezone: tz }))
            }
            retention={fields.retention}
            onRetentionChange={(count) =>
              setFields((f) => ({ ...f, retention: count }))
            }
          />
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
                !fields.name.trim() ||
                !fields.destinationId ||
                !isValidSchedule(fields.schedule)
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

/* ------------------------------------------------------------------ */
/* Schedule row (toggle + run + delete)                                */
/* ------------------------------------------------------------------ */

function ScheduleRow({
  schedule,
  target,
  destinations,
  canManage,
  canTestDestinations,
  onStart,
}: {
  schedule: BackupDTO;
  target: BackupTarget;
  destinations: Destination[];
  canManage: boolean;
  canTestDestinations: boolean;
  onStart: (destinationId: string, run: () => Promise<unknown>) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const { hide, restore } = useOptimisticRow(schedule.id);
  const [editOpen, setEditOpen] = React.useState(false);
  // Locally in flight: the mutation resolves at the END of the dump, and the
  // stored `lastStatus` only says `running` after the next refresh, so without
  // this the button stays clickable for seconds after it was pressed.
  const [running, setRunning] = React.useState(false);
  const isRunning = running || schedule.lastStatus === "running";

  function run() {
    // Resolves at the END of the dump, so the toast is the RESULT. What says "it
    // started" is the placeholder row `onStart` puts in the artifacts table, and
    // this row going `running` a tick later.
    setRunning(true);
    onStart(schedule.destinationId, () =>
      gqlAction(`mutation($id: String!) { runBackup(id: $id) }`, {
        id: schedule.id,
      }).then((res) => {
        setRunning(false);
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
        {schedule.retentionCount}{" "}
        {schedule.retentionCount === 1 ? "backup" : "backups"}
      </TableCell>
      <TableCell>
        {isRunning ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            Running
          </span>
        ) : schedule.lastStatus === "never" ? (
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
          disabled={pending || !canManage}
        />
      </TableCell>
      <TableCell className="text-right">
        <div className="flex items-center justify-end gap-1">
          <IconAction
            label="Run backup now"
            disabled={pending || isRunning || !canManage}
            tooltip={
              !canManage
                ? "You don't have permission to run backups"
                : isRunning
                  ? "This backup is already running"
                  : "Run this backup now"
            }
            onClick={run}
          >
            <Play className="size-4" />
          </IconAction>
          <IconAction
            label="Edit schedule"
            disabled={!canManage}
            tooltip={
              canManage
                ? "Edit this schedule"
                : "You don't have permission to edit backup schedules"
            }
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="size-4" />
          </IconAction>
          <IconAction
            label="Delete schedule"
            disabled={!canManage}
            tooltip={
              canManage
                ? "Delete this schedule"
                : "You don't have permission to delete backup schedules"
            }
            onClick={() => setConfirmOpen(true)}
          >
            <Trash2 className="size-4 text-destructive" />
          </IconAction>
        </div>
        {/* key on `editOpen` so each open remounts the dialog with fresh state
            seeded from the current schedule, no reset effect needed. */}
        <EditScheduleDialog
          key={editOpen ? "edit-open" : "edit-closed"}
          schedule={schedule}
          target={target}
          destinations={destinations}
          canTestDestinations={canTestDestinations}
          open={editOpen}
          onOpenChange={setEditOpen}
        />
        <ConfirmAction
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Delete backup schedule?"
          description={`${schedule.name} stops running. Backups it already made are kept.`}
          confirmLabel="Delete schedule"
          successMessage="Backup schedule deleted"
          optimistic
          onConfirm={async () => {
            hide();
            const res = await gqlAction(
              `mutation($id: String!) { deleteBackup(id: $id) }`,
              { id: schedule.id },
            );
            if (!res.ok) restore();
            router.refresh();
            return res;
          }}
        />
      </TableCell>
    </TableRow>
  );
}

/**
 * One icon button with a tooltip that survives being disabled.
 */
function IconAction({
  label,
  tooltip,
  disabled,
  onClick,
  children,
}: {
  label: string;
  tooltip: string;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const button = (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      {children}
    </Button>
  );
  return (
    <SimpleTooltip content={tooltip}>
      {disabled ? <span tabIndex={0}>{button}</span> : button}
    </SimpleTooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Run rows (restore points)                                           */
/* ------------------------------------------------------------------ */

/**
 * A run that was started from this page and has not surfaced yet. It never
 * pretends to be finished: it pulses, its actions are dead, and it says Running.
 */
function PendingRunRow({
  destinationName,
  canRestore,
}: {
  destinationName: string;
  canRestore: boolean;
}) {
  return (
    <TableRow aria-busy className="animate-pulse select-none">
      <TableCell className="text-sm">just now</TableCell>
      <TableCell className="text-muted-foreground">{destinationName}</TableCell>
      <TableCell className="text-muted-foreground">—</TableCell>
      <TableCell>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" />
          Running
        </span>
      </TableCell>
      <TableCell className="text-right">
        <RunActions href={null} running ok={false} canRestore={canRestore} />
      </TableCell>
    </TableRow>
  );
}

/**
 * The two things you can do with an artifact.
 */
function RunActions({
  href,
  running,
  ok,
  canRestore,
  canDelete = false,
  canManage = false,
  onRestore,
  onDelete,
  onCancel,
}: {
  /** The download URL, or null for a run that has no id yet (the placeholder). */
  href: string | null;
  running: boolean;
  ok: boolean;
  canRestore: boolean;
  canDelete?: boolean;
  /** `manage_backups` - whoever may start a dump may stop it. */
  canManage?: boolean;
  onRestore?: () => void;
  onDelete?: () => void;
  onCancel?: () => void;
}) {
  // Every successful artifact is downloadable, wherever it is kept.
  const canDownload = ok && canRestore && href !== null;
  function reason(verb: "download" | "restore") {
    if (!canRestore) return `You don't have permission to ${verb} backups`;
    if (running) return "This backup is still running";
    if (!ok)
      return verb === "download"
        ? "Only a successful backup can be downloaded"
        : "Only a successful backup can be restored";
    return verb === "restore"
      ? "Restore this backup in place"
      : "Download this backup file";
  }
  // Delete is the one action a FAILED run still has: its record is clutter and
  // clearing it is the only thing left to do with it.
  function deleteReason() {
    if (!canDelete) return "You don't have permission to delete backups";
    if (running) return "This backup is still running";
    return "Delete this backup permanently";
  }
  // Icon + label as DIRECT children of the button, never wrapped: one <span> around
  // them makes the pair a single flex item, and the button's `gap-2` and
  // `items-center` stop applying - the icon glues to the text and drops onto its
  const downloadLabel = (
    <>
      <Download className="size-4" />
      Download
    </>
  );

  return (
    <div className="flex items-center justify-end gap-1">
      {/* The file itself, decrypted. The reason a folder on your own server is
          worth having: the backup is a thing you can hold, not only a thing
          Deplo can put back. */}
      <TooltipWhenDisabled disabled={!canDownload} tooltip={reason("download")}>
        <Button
          variant="ghost"
          size="sm"
          asChild={canDownload}
          disabled={!canDownload}
        >
          {canDownload ? (
            <a href={href} download>
              {downloadLabel}
            </a>
          ) : (
            downloadLabel
          )}
        </Button>
      </TooltipWhenDisabled>
      <TooltipWhenDisabled
        disabled={!ok || !canRestore}
        tooltip={reason("restore")}
      >
        <Button
          variant="ghost"
          size="sm"
          disabled={!ok || !canRestore}
          onClick={onRestore}
        >
          <RotateCcw className="size-4" />
          Restore
        </Button>
      </TooltipWhenDisabled>
      {/* Only while it is running, and then it is the ONLY thing to do with the
          row: nothing else on it can act on a dump that has not finished. */}
      {running && onCancel && (
        <IconAction
          label="Stop this backup"
          tooltip={
            canManage
              ? "Stop this backup and discard what it has written"
              : "You don't have permission to stop backups"
          }
          disabled={!canManage}
          onClick={onCancel}
        >
          <Square className="size-4" />
        </IconAction>
      )}
      {/**
       * Icon-only, unlike its two neighbours: this is the destructive one, and a third
       * labelled button would give it the same weight as Download.
       */}
      <IconAction
        label="Delete this backup"
        tooltip={deleteReason()}
        disabled={!canDelete || running}
        onClick={() => onDelete?.()}
      >
        <Trash2 className="size-4" />
      </IconAction>
    </div>
  );
}

function RunRow({
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
  const router = useRouter();
  const [restoreOpen, setRestoreOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const { hide, restore } = useOptimisticRow(run.id);
  const [cancelOpen, setCancelOpen] = React.useState(false);
  const ok = run.status === "success";

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
        {ok ? formatBytes(run.sizeBytes) : "—"}
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
        {ok && !run.sha256 && (
          <SimpleTooltip content="Taken before Deplo recorded checksums, so it cannot prove this file is unchanged">
            <span className="mt-1 block text-[10px] text-muted-foreground">
              Not checksummed
            </span>
          </SimpleTooltip>
        )}
      </TableCell>
      <TableCell className="text-right">
        <RunActions
          href={`/api/backups/${run.id}/download`}
          running={run.status === "running"}
          ok={ok}
          canRestore={canRestore}
          canDelete={canDelete}
          canManage={canManage}
          onRestore={() => setRestoreOpen(true)}
          onDelete={() => setDeleteOpen(true)}
          onCancel={() => setCancelOpen(true)}
        />
        <ConfirmAction
          open={cancelOpen}
          onOpenChange={setCancelOpen}
          title="Stop this backup?"
          confirmLabel="Stop backup"
          successMessage="Backup stopped"
          description="The dump stops on the server and nothing is kept: the half-written file is removed, so this leaves no backup behind."
          onConfirm={async () => {
            const res = await gqlAction(
              `mutation($runId: String!) { cancelBackupRun(runId: $runId) }`,
              { runId: run.id },
            );
            if (res.ok) router.refresh();
            return res;
          }}
        />
        <ConfirmAction
          open={restoreOpen}
          onOpenChange={setRestoreOpen}
          title="Restore this backup?"
          confirmLabel="Restore"
          successMessage="Restore started"
          confirmText={target.name}
          description={
            <span className="flex flex-col gap-2">
              <span className="flex items-start gap-2 text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  This overwrites <strong>{target.name}</strong> in place with
                  the backup from {timeAgo(run.startedAt)}. The {noun(target)}{" "}
                  is stopped, its current data is wiped, and the snapshot is
                  restored - there is downtime and the current state is{" "}
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
        {/**
         * No typed confirmation, unlike Restore. Asking someone to type an app's name to
         * delete a failed run would be ceremony, and ceremony everywhere is ceremony
         * nowhere.
         */}
        <ConfirmAction
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          title="Delete this backup?"
          confirmLabel="Delete backup"
          successMessage="Backup deleted"
          description={
            ok
              ? `The ${formatBytes(run.sizeBytes)} file from ${timeAgo(run.startedAt)} is deleted from ${destinationName}. You can't restore ${target.name} from it afterwards.`
              : `This run failed and left no file, so only its record is removed.`
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
      </TableCell>
    </TableRow>
  );
}

/** {@link IconAction}'s wrapper, for buttons that carry their own label. */
function TooltipWhenDisabled({
  disabled,
  tooltip,
  children,
}: {
  disabled: boolean;
  tooltip: string;
  /** Exactly one element - `TooltipTrigger asChild` clones it. */
  children: React.ReactElement;
}) {
  return (
    <SimpleTooltip content={tooltip}>
      {disabled ? <span tabIndex={0}>{children}</span> : children}
    </SimpleTooltip>
  );
}
