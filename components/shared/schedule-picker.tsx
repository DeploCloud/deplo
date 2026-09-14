"use client";

import * as React from "react";

import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel } from "@/components/ui/info-tip";
import type { DocsTopic } from "@/lib/docs";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  DEFAULT_PARTS,
  MAX_MONTH_DAY,
  SCHEDULE_OPTIONS,
  WEEKDAY_LABELS,
  cronFromParts,
  describeCron,
  isValidSchedule,
  partsFromCron,
  type ScheduleMode,
  type ScheduleParts,
} from "@/lib/schedule";
import { nextCronRunInZone } from "@/lib/crons/cron-tz";

const pad = (n: number) => String(n).padStart(2, "0");

const GROUPS = [...new Set(SCHEDULE_OPTIONS.map((o) => o.group))];

const DEFAULT_INFO =
  "How often this runs. Pick a frequency - the details it needs appear next to it. " +
  "Writing a cron expression by hand is the last option in the list.";

const NEVER_CHANGES = () => () => {};
const onClient = () => true;
const onServer = () => false;

// SchedulePicker - pick a schedule without writing cron; the raw expression is the last item, under Advanced.
export function SchedulePicker({
  value,
  onChange,
  trailing,
  disabled,
  id = "schedule",
  label = "Schedule",
  info = DEFAULT_INFO,
  docs,
  timezone = "UTC",
  summary = true,
  omitModes,
}: {
  value: string;
  onChange: (cron: string) => void;
  trailing?: React.ReactNode;
  disabled?: boolean;
  id?: string;
  label?: React.ReactNode;
  info?: React.ReactNode;
  docs?: DocsTopic;
  timezone?: string;
  summary?: boolean;
  omitModes?: readonly ScheduleMode[];
}) {
  const [parts, setParts] = React.useState<ScheduleParts>(
    () => partsFromCron(value) ?? DEFAULT_PARTS,
  );
  const [custom, setCustom] = React.useState(
    () => partsFromCron(value) === null,
  );

  const mode: ScheduleMode = custom ? "custom" : parts.mode;
  const options = omitModes?.length
    ? SCHEDULE_OPTIONS.filter((o) => !omitModes.includes(o.mode))
    : SCHEDULE_OPTIONS;
  const groups = GROUPS.filter((g) => options.some((o) => o.group === g));
  const valid = isValidSchedule(value);
  const description = describeCron(value, { timeZone: timezone });

  // After hydration only: the reader's timezone and clock are not the server's.
  const hydrated = React.useSyncExternalStore(
    NEVER_CHANGES,
    onClient,
    onServer,
  );
  const nextRun = hydrated
    ? nextCronRunInZone(value, new Date(), timezone)
    : null;

  function apply(next: ScheduleParts) {
    setParts(next);
    onChange(cronFromParts(next));
  }

  function pickMode(next: string) {
    if (next === "custom") {
      setCustom(true);
      return;
    }
    setCustom(false);
    apply({ ...parts, mode: next as ScheduleMode });
  }

  function pickTime(time: string) {
    const [h, m] = time.split(":");
    const hour = Number(h);
    const minute = Number(m);
    // A cleared `type="time"` input reports "" - ignore it rather than emit NaN.
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return;
    apply({ ...parts, hour, minute });
  }

  const needsTime = mode === "daily" || mode === "weekly" || mode === "monthly";

  const dayField =
    mode === "weekly" ? (
      <div className="space-y-2">
        <FieldLabel
          htmlFor={`${id}-weekday`}
          info="Which day of the week it runs on."
        >
          Day
        </FieldLabel>
        <Select
          value={String(parts.weekday)}
          onValueChange={(v) => apply({ ...parts, weekday: Number(v) })}
          disabled={disabled}
        >
          <SelectTrigger id={`${id}-weekday`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {WEEKDAY_LABELS.map((label, i) => (
              <SelectItem key={label} value={String(i)}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : mode === "monthly" ? (
      <div className="space-y-2">
        <FieldLabel
          htmlFor={`${id}-day`}
          info={`Which day of the month it runs on. Stops at ${MAX_MONTH_DAY} on purpose - a later day would silently skip the months that don't have it.`}
        >
          Day of month
        </FieldLabel>
        <Select
          value={String(parts.day)}
          onValueChange={(v) => apply({ ...parts, day: Number(v) })}
          disabled={disabled}
        >
          <SelectTrigger id={`${id}-day`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Array.from({ length: MAX_MONTH_DAY }, (_, i) => i + 1).map((d) => (
              <SelectItem key={d} value={String(d)}>
                {d}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : null;

  return (
    <div className="grid gap-4">
      {/* Row 1 - how often, plus the day that frequency has to pin down. */}
      <div className={dayField ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"}>
        <div className="space-y-2">
          <FieldLabel htmlFor={id} info={info} docs={docs}>
            {label}
          </FieldLabel>
          <Select value={mode} onValueChange={pickMode} disabled={disabled}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {groups.map((group) => (
                <SelectGroup key={group}>
                  <SelectLabel>{group}</SelectLabel>
                  {options
                    .filter((o) => o.group === group)
                    .map((o) => (
                      <SelectItem key={o.mode} value={o.mode}>
                        {o.label}
                      </SelectItem>
                    ))}
                </SelectGroup>
              ))}
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Advanced</SelectLabel>
                <SelectItem value="custom">Custom cron expression</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          {/* The raw expression IS the frequency, so it sits in that cell, not on its own row. */}
          {custom && (
            <Input
              aria-label="Cron expression"
              value={value}
              onChange={(e) => onChange(e.target.value)}
              className="font-mono text-xs"
              placeholder="0 3 * * *"
              autoComplete="off"
              spellCheck={false}
              disabled={disabled}
            />
          )}
        </div>
        {dayField}
      </div>

      {/* Row 2 - the time of day, on the same axis as whatever the caller pairs with it. */}
      <div className="space-y-2">
        {(needsTime || trailing) && (
          <div className="grid gap-4 sm:grid-cols-2">
            {needsTime && (
              <div className="space-y-2">
                <FieldLabel
                  htmlFor={`${id}-time`}
                  info={`The time of day it runs, in ${timezone}. The line below shows when that lands in your own timezone.`}
                >
                  Time ({timezone})
                </FieldLabel>
                <Input
                  id={`${id}-time`}
                  type="time"
                  step={60}
                  value={`${pad(parts.hour)}:${pad(parts.minute)}`}
                  onChange={(e) => pickTime(e.target.value)}
                  disabled={disabled}
                />
              </div>
            )}
            {trailing}
          </div>
        )}

        {valid ? (
          summary && (
            <p className="text-xs text-muted-foreground">
              {description ?? "Custom schedule"}
              {nextRun && (
                <>
                  {" · next run "}
                  <span className="text-foreground">
                    {formatLocal(nextRun)}
                  </span>
                  {" your time"}
                </>
              )}
            </p>
          )
        ) : (
          <p className="text-xs text-destructive">
            Not a valid cron expression. Use 5 fields - minute hour day month
            weekday.
          </p>
        )}
      </div>
    </div>
  );
}

// ScheduleLabel - a stored schedule read back as words, the display twin of the picker.
export function ScheduleLabel({
  cron,
  timezone = "UTC",
}: {
  cron: string;
  timezone?: string;
}) {
  const compact = describeCron(cron, { compact: true, timeZone: timezone });
  if (!compact) return <code className="font-mono text-xs">{cron}</code>;
  return (
    <SimpleTooltip content={<code className="font-mono">{cron}</code>}>
      <span className="text-xs">{compact}</span>
    </SimpleTooltip>
  );
}

function formatLocal(at: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}
