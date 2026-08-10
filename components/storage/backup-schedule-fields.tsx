"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { SchedulePicker } from "@/components/shared/schedule-picker";
import { TimezonePicker } from "@/components/servers/timezone-picker";
import { dstSkipWarning } from "@/lib/crons/cron-tz";

/**
 * When a backup runs, and how long its files are kept. One component because
 * three dialogs ask it - schedule a backup from Storage, from an app's Backups
 * tab, and edit either - and the three drifting apart is how a field ends up
 * existing in two of them.
 *
 * The TIMEZONE is the part worth explaining. A backup schedule used to be read
 * in UTC and nothing said so above the field, which for anyone outside that zone
 * meant "nightly at 03:00" quietly became 04:00 for half the year and 05:00 for
 * the other half. The cron-jobs feature next door had already solved this per
 * job, with the same picker and the same evaluator, so the fix is to ask - and
 * the default is the reader's own clock, because 03:00 means 03:00 where you
 * are.
 */
export function BackupScheduleFields({
  idPrefix,
  schedule,
  onScheduleChange,
  timezone,
  onTimezoneChange,
  retention,
  onRetentionChange,
}: {
  /** Prefix for the generated control ids, so two forms on a page still bind. */
  idPrefix: string;
  schedule: string;
  onScheduleChange: (cron: string) => void;
  timezone: string;
  onTimezoneChange: (tz: string) => void;
  retention: number;
  onRetentionChange: (days: number) => void;
}) {
  // Read once, lazily: the zone list shows a live clock per zone, and a fresh
  // Date on every render would restart that ticking on each keystroke.
  const [pickerNow] = React.useState(() => Date.now());
  const dstWarning = dstSkipWarning(schedule, timezone);

  return (
    <div className="space-y-4">
      <SchedulePicker
        id={`${idPrefix}-schedule`}
        value={schedule}
        onChange={onScheduleChange}
        timezone={timezone}
        info="How often this backup runs. Pick a frequency - the details it needs appear next to it. Writing a cron expression by hand is the last option in the list."
        trailing={
          <div className="space-y-2">
            <FieldLabel
              htmlFor={`${idPrefix}-retention`}
              info="How long a finished backup is kept before older ones are removed."
            >
              Retention (days)
            </FieldLabel>
            <Input
              id={`${idPrefix}-retention`}
              type="number"
              value={retention}
              onChange={(e) => onRetentionChange(Number(e.target.value) || 7)}
              min={1}
            />
          </div>
        }
      />
      <div className="space-y-2">
        <FieldLabel
          htmlFor={`${idPrefix}-timezone`}
          info="The clock this schedule is read on. Defaults to yours, so 03:00 means 03:00 where you are."
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
      {dstWarning && <p className="text-xs text-warning">{dstWarning}</p>}
    </div>
  );
}

/** The reader's own zone, which is what a new schedule should default to. */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
