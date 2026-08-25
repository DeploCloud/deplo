"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Archive,
  Boxes,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Database as DatabaseIcon,
  Loader2,
  Plus,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AnimatedHeight } from "@/components/shared/animated-height";
import { KindCard } from "@/components/shared/kind-card";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import {
  BackupScheduleFields,
  DEFAULT_RETENTION,
  browserTimezone,
  suggestScheduleName,
} from "@/components/storage/backup-schedule-fields";
import { DestinationCombobox } from "@/components/storage/destination-combobox";
import {
  TargetCombobox,
  type BackupTargetOption,
} from "@/components/storage/target-combobox";
import { gqlAction } from "@/lib/graphql-client";
import { DEFAULT_SCHEDULE, isValidSchedule } from "@/lib/schedule";
import { cn } from "@/lib/utils";
import type { DestinationOption } from "@/lib/data/destinations";

type TargetKind = "database" | "app";

type StepId = "target" | "destination" | "schedule";

const STEPS: { id: StepId; label: string }[] = [
  { id: "target", label: "Target" },
  { id: "destination", label: "Destination" },
  { id: "schedule", label: "Schedule" },
];

/** Per-step heading, icon and one line of orientation. */
const COPY: Record<
  StepId,
  {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    blurb: string;
  }
> = {
  target: {
    icon: Boxes,
    title: "What are you backing up?",
    blurb:
      "An app backup captures its volumes, files and settings. A database backup is a dump of that database alone.",
  },
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
 * Schedule a backup from Storage, where nothing about the target is known yet. The
 * per-app and per-database tabs run the same wizard minus this first step
 * (`ScheduleBackup` in `backups-panel.tsx`), because there the target is the page.
 */
export function CreateBackup({
  databases,
  services = [],
  destinations,
  canCreate = true,
  canTestDestinations = false,
  autoOpen = false,
}: {
  /** `serverId` is only used to flag a destination sitting on the target's own
   *  disk; leave it out and the picker simply says nothing. */
  databases: BackupTargetOption[];
  services?: BackupTargetOption[];
  destinations: DestinationOption[];
  /**
   * Whether the current user may schedule a backup (`manage_backups`).
   */
  canCreate?: boolean;
  /** Whether this user may run the destination picker's live probe
   *  (`manage_backup_destinations`). Without it the picker shows the stored
   *  badges instead of firing a mutation the server would refuse. */
  canTestDestinations?: boolean;
  /** Open on mount — used by the global "New ▸ Schedule backup" menu
   *  (which links to /storage?new=backup). */
  autoOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(autoOpen && canCreate);
  const [pending, startTransition] = React.useTransition();
  const [step, setStep] = React.useState<StepId>("target");

  // Drop the ?new=backup param after opening so a refresh/Back doesn't reopen it.
  React.useEffect(() => {
    if (autoOpen) router.replace("/storage", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Named after its frequency until the user says otherwise — the same as the
  // per-app dialog, so the two never disagree about what a new schedule is
  // called or about whether Create is reachable on open.
  const [name, setName] = React.useState(() =>
    suggestScheduleName(DEFAULT_SCHEDULE),
  );
  const [nameTouched, setNameTouched] = React.useState(false);
  // Apps are the common case — a whole app (volumes, files, compose/env snapshot) is
  // what most people come here to protect, and a database that matters usually
  // belongs to one.
  const [targetKind, setTargetKind] = React.useState<TargetKind>(
    services.length === 0 && databases.length > 0 ? "database" : "app",
  );
  const [databaseId, setDatabaseId] = React.useState<string>(
    databases[0]?.id ?? "",
  );
  const [appId, setAppId] = React.useState<string>(services[0]?.id ?? "");
  const [destinationId, setDestinationId] = React.useState<string>(
    destinations[0]?.id ?? "",
  );
  const [schedule, setSchedule] = React.useState(DEFAULT_SCHEDULE);
  const [timezone, setTimezone] = React.useState(browserTimezone);
  const [retention, setRetention] = React.useState(DEFAULT_RETENTION);

  const noDeps = destinations.length === 0;
  // Why the button can't be clicked, if it can't. The missing permission wins:
  // adding a destination would not unblock it.
  const blocked = !canCreate
    ? "You don't have permission to schedule backups"
    : noDeps
      ? "Add a backup destination first"
      : null;
  // The chosen target must have a concrete id selected — otherwise the schedule
  // would point at nothing.
  const targetId = targetKind === "database" ? databaseId : appId;
  // The server the chosen target runs on — a destination on it is a same-disk copy.
  const targetServerId =
    (targetKind === "database" ? databases : services).find(
      (t) => t.id === targetId,
    )?.serverId ?? null;

  /** What each step needs before the next one means anything. */
  const complete: Record<StepId, boolean> = {
    target: !!targetId,
    destination: !!destinationId,
    schedule: !!name.trim() && isValidSchedule(schedule),
  };
  const index = STEPS.findIndex((s) => s.id === step);
  const { icon: StepIcon, title, blurb } = COPY[step];

  function close() {
    setOpen(false);
    // Deferred so the close animation does not play over a form that has
    // already snapped back to step one.
    setTimeout(() => setStep("target"), 200);
  }

  /** Enter runs whatever the current step's primary button does. */
  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending || !complete[step]) return;
    if (step === "schedule") submit();
    else setStep(STEPS[index + 1]!.id);
  }

  function submit() {
    // The wizard closes on the click and the schedule is written behind it; a
    // refusal reopens it on the step it was left on, fields intact.
    setOpen(false);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: CreateBackupInput!) { createBackup(input: $input) }`,
        {
          input: {
            name,
            targetKind,
            databaseId: targetKind === "database" ? databaseId || null : null,
            appId: targetKind === "app" ? appId || null : null,
            destinationId,
            schedule,
            timezone,
            retentionCount: retention,
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
            // Disabled buttons swallow pointer events, so wrap in a focusable
            // span to keep the tooltip reachable. No DialogTrigger here means a
            // click can never open the dialog while it is blocked.
            <span tabIndex={0}>
              <Button size="sm" disabled>
                <Plus className="size-4" />
                New Backup
              </Button>
            </span>
          ) : (
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4" />
                New Backup
              </Button>
            </DialogTrigger>
          )}
        </TooltipTrigger>
        <TooltipContent>{blocked ?? "Schedule a backup"}</TooltipContent>
      </Tooltip>
      {/* No `overflow-hidden` here: the step box below clips itself while it is
          animating, and the rest of the time a combobox menu has to be free to
          hang past the field it belongs to. */}
      <DialogContent selfManaged className="sm:max-w-lg">
        <DialogHeader className="space-y-0 pr-8">
          <DialogTitle className="sr-only">Schedule a backup</DialogTitle>
          <DialogDescription className="sr-only">
            Periodically back up a database or an app to a backup destination,
            in three steps.
          </DialogDescription>
          <WizardStepper
            steps={STEPS}
            current={step}
            // Every answer here is the user's own and stays editable, so any step
            // whose predecessors are settled can be jumped back to.
            reachable={(s) =>
              STEPS.slice(
                0,
                STEPS.findIndex((x) => x.id === s),
              ).every((x) => complete[x.id])
            }
            onSelect={setStep}
          />
        </DialogHeader>

        <form onSubmit={onSubmit} className="grid gap-4">
          {/* The height is the STEP's, measured, so "what are you backing up?"
              is a short box and only the schedule step is a tall one — a wizard
              padded to its tallest step spends two thirds of itself on air. */}
          <AnimatedHeight className="mx-auto flex w-full max-w-md flex-col gap-5 py-2">
            {/* One heading block, same shape on every step, so the eye lands
                in the same place each time the body swaps under it. */}
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-primary/10">
                <StepIcon className="size-5 text-primary" />
              </span>
              <h2 className="text-base font-semibold lg:text-lg">{title}</h2>
              <p className="text-sm text-balance text-muted-foreground">
                {blurb}
              </p>
            </div>

            {step === "target" && (
              <div className="space-y-4">
                <div
                  role="radiogroup"
                  aria-label="What to back up"
                  className="grid gap-3 sm:grid-cols-2"
                >
                  <KindCard
                    title="App"
                    caption="Volumes, files and settings"
                    icon={<Boxes className="size-4" />}
                    selected={targetKind === "app"}
                    disabled={services.length === 0}
                    disabledNote="No apps in this team yet"
                    onSelect={() => setTargetKind("app")}
                  />
                  <KindCard
                    title="Database"
                    caption="A dump of one database"
                    icon={<DatabaseIcon className="size-4" />}
                    selected={targetKind === "database"}
                    disabled={databases.length === 0}
                    disabledNote="No databases in this team yet"
                    onSelect={() => setTargetKind("database")}
                  />
                </div>
                <div className="space-y-2">
                  {targetKind === "database" ? (
                    <>
                      <FieldLabel htmlFor="new-backup-database">
                        Database
                      </FieldLabel>
                      <TargetCombobox
                        id="new-backup-database"
                        kind="database"
                        targets={databases}
                        value={databaseId}
                        onChange={setDatabaseId}
                      />
                    </>
                  ) : (
                    <>
                      <FieldLabel htmlFor="new-backup-app">App</FieldLabel>
                      <TargetCombobox
                        id="new-backup-app"
                        kind="app"
                        targets={services}
                        value={appId}
                        onChange={setAppId}
                      />
                    </>
                  )}
                </div>
              </div>
            )}

            {step === "destination" && (
              <div className="space-y-2">
                <FieldLabel
                  htmlFor="new-backup-destination"
                  info="Where backup archives are written and kept. Each one shows whether Deplo could reach it."
                >
                  Destination
                </FieldLabel>
                <DestinationCombobox
                  id="new-backup-destination"
                  destinations={destinations}
                  value={destinationId}
                  onChange={setDestinationId}
                  sameDiskServerId={targetServerId}
                  sameDiskNoun={targetKind === "database" ? "database" : "app"}
                  canProbe={canTestDestinations}
                />
              </div>
            )}

            {step === "schedule" && (
              <div className="space-y-4">
                <div className="space-y-2">
                  <FieldLabel
                    htmlFor="new-backup-name"
                    info="What this schedule is called in the list. Follows the frequency until you change it."
                  >
                    Name
                  </FieldLabel>
                  <Input
                    id="new-backup-name"
                    value={name}
                    onChange={(e) => {
                      setNameTouched(true);
                      setName(e.target.value);
                    }}
                  />
                </div>
                <BackupScheduleFields
                  idPrefix="new-backup"
                  schedule={schedule}
                  onScheduleChange={(cron) => {
                    setSchedule(cron);
                    if (!nameTouched) setName(suggestScheduleName(cron));
                  }}
                  timezone={timezone}
                  onTimezoneChange={setTimezone}
                  retention={retention}
                  onRetentionChange={setRetention}
                />
              </div>
            )}
          </AnimatedHeight>

          <DialogFooter className="flex-row items-center justify-between sm:justify-between">
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
                <Button type="submit" disabled={!complete[step]}>
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
