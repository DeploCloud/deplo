"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { SchedulePicker } from "@/components/shared/schedule-picker";
import { TimezonePicker } from "@/components/servers/timezone-picker";
import { dstSkipWarning } from "@/lib/crons/cron-tz";
import {
  SCHEDULE_OPTIONS,
  backupTooFrequent,
  cronFromParts,
  DEFAULT_PARTS,
  partsFromCron,
} from "@/lib/schedule";
import { cn } from "@/lib/utils";

const TOO_FREQUENT = SCHEDULE_OPTIONS.filter((o) =>
  backupTooFrequent(cronFromParts({ ...DEFAULT_PARTS, mode: o.mode })),
).map((o) => o.mode);

export const DEFAULT_RETENTION = 7;

export function suggestScheduleName(cron: string): string {
  const mode = partsFromCron(cron)?.mode;
  const label = SCHEDULE_OPTIONS.find((o) => o.mode === mode)?.label;
  return label ? `Backup ${label.toLowerCase()}` : "Scheduled backup";
}

export function BackupScheduleFields({
  idPrefix,
  schedule,
  onScheduleChange,
  timezone,
  onTimezoneChange,
  retention,
  onRetentionChange,
}: {
  idPrefix: string;
  schedule: string;
  onScheduleChange: (cron: string) => void;
  timezone: string;
  onTimezoneChange: (tz: string) => void;
  retention: number;
  onRetentionChange: (count: number) => void;
}) {
  const [pickerNow] = React.useState(() => Date.now());
  const dstWarning = dstSkipWarning(schedule, timezone);

  return (
    <div className="space-y-4">
      <SchedulePicker
        id={`${idPrefix}-schedule`}
        value={schedule}
        onChange={onScheduleChange}
        timezone={timezone}
        summary={false}
        omitModes={TOO_FREQUENT}
        info="How often this backup runs. Pick a frequency - the details it needs appear next to it. Writing a cron expression by hand is the last option in the list."
        docs="backups.schedule"
        trailing={
          <div className="space-y-2">
            <FieldLabel
              htmlFor={`${idPrefix}-timezone`}
              info="The clock this schedule is read on. Defaults to yours, so 03:00 means 03:00 where you are."
              docs="backups.schedule"
            >
              Timezone
            </FieldLabel>
            <TimezonePicker
              id={`${idPrefix}-timezone`}
              value={timezone}
              onChange={onTimezoneChange}
              now={pickerNow}
            />
          </div>
        }
      />
      {dstWarning && <p className="text-xs text-warning">{dstWarning}</p>}
      <div className="space-y-2">
        <FieldLabel
          htmlFor={`${idPrefix}-retention`}
          info="How many backups to keep here. After each successful run the older ones are removed, and the newest one is never removed."
          docs="backups.retention"
        >
          Keep
        </FieldLabel>
        <div className="relative">
          <Input
            id={`${idPrefix}-retention`}
            type="number"
            inputMode="numeric"
            value={retention}
            onChange={(e) =>
              onRetentionChange(Number(e.target.value) || DEFAULT_RETENTION)
            }
            min={1}
            max={365}
            className={cn(
              "pr-20",
              "[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none",
            )}
          />
          <span className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-3 text-xs font-medium text-muted-foreground">
            {retention === 1 ? "backup" : "backups"}
          </span>
        </div>
      </div>
    </div>
  );
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
