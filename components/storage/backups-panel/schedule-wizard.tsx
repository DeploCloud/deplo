"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  Archive,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AnimatedHeight } from "@/components/shared/animated-height";
import { WizardStepper } from "@/components/shared/wizard-stepper";
import { cn } from "@/lib/utils";
import {
  BackupScheduleFields,
  DEFAULT_RETENTION,
  browserTimezone,
  suggestScheduleName,
} from "@/components/storage/backup-schedule-fields";
import { gqlAction } from "@/lib/graphql-client";
import { DEFAULT_SCHEDULE, isValidSchedule } from "@/lib/schedule";
import { noun, type BackupTarget, type Destination } from "./target";
import {
  DestinationField,
  NameField,
  type ScheduleFields,
} from "./schedule-fields";

type StepId = "destination" | "schedule";

const STEPS: { id: StepId; label: string }[] = [
  { id: "destination", label: "Destination" },
  { id: "schedule", label: "Schedule" },
];

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

export function ScheduleBackup({
  target,
  destinations,
  canTestDestinations,
  open,
  onOpenChange,
}: {
  target: BackupTarget;
  destinations: Destination[];
  canTestDestinations: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [step, setStep] = React.useState<StepId>("destination");
  const [nameTouched, setNameTouched] = React.useState(false);
  const [fields, setFields] = React.useState<ScheduleFields>(() => ({
    name: suggestScheduleName(DEFAULT_SCHEDULE),
    destinationId: destinations[0]?.id ?? "",
    schedule: DEFAULT_SCHEDULE,
    timezone: browserTimezone(),
    retention: DEFAULT_RETENTION,
  }));
  const complete: Record<StepId, boolean> = {
    destination: !!fields.destinationId,
    schedule: !!fields.name.trim() && isValidSchedule(fields.schedule),
  };
  const index = STEPS.findIndex((s) => s.id === step);
  const { icon: StepIcon, title, blurb } = STEP_COPY[step];

  function close() {
    onOpenChange(false);
    setTimeout(() => setStep("destination"), 200);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending || !complete[step]) return;
    if (step === "schedule") submit();
    else setStep(STEPS[index + 1]!.id);
  }

  function submit() {
    onOpenChange(false);
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
        onOpenChange(true);
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => (o ? onOpenChange(true) : close())}
    >
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
            <div className="flex flex-col items-center gap-2 text-center">
              <span className="flex size-10 items-center justify-center rounded-full bg-primary-wash-strong">
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
