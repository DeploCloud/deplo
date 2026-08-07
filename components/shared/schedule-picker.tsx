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

/** Order the groups appear in, taken from the options list itself. */
const GROUPS = [...new Set(SCHEDULE_OPTIONS.map((o) => o.group))];

const DEFAULT_INFO =
  "How often this runs. Pick a frequency — the details it needs appear next to it. " +
  "Writing a cron expression by hand is the last option in the list.";

/* The "have we hydrated yet?" store: nothing to subscribe to, the snapshot just
   differs between the two renderers. */
const NEVER_CHANGES = () => () => {};
const onClient = () => true;
const onServer = () => false;

/**
 * Pick a schedule without writing cron.
 *
 * The value this emits is still a 5-field cron expression — that is what the
 * scheduler evaluates and what the column stores — but nobody has to type one.
 * A frequency dropdown covers the whole ladder (every minute → every month);
 * picking "Every day", "Every week" or "Every month" reveals just the one or two
 * extra controls that frequency actually needs (a time, a weekday, a day of the
 * month). Writing cron by hand survives as the last item in the list, under
 * "Advanced" — reachable for the expert, never the first thing a newcomer sees.
 *
 * Two things keep it honest. The line underneath restates the choice in words
 * and resolves the *next* run in the reader's own timezone, so "03:00 UTC" never
 * has to be converted in anyone's head. And a hand-typed expression that would
 * never fire is called out inline rather than accepted — the data layer rejects
 * it too, because a schedule that silently never runs while the UI says
 * "enabled" is the worst outcome this feature has.
 *
 * Controlled: `value` is the cron string, `onChange` gets the new one. Which
 * controls got you there is local state, seeded from `value` on mount — so an
 * edit dialog opens on the matching preset, and only an expression outside that
 * vocabulary opens on the raw text.
 */
export function SchedulePicker({
  value,
  onChange,
  trailing,
  disabled,
  id = "schedule",
  label = "Schedule",
  info = DEFAULT_INFO,
  timezone = "UTC",
}: {
  value: string;
  onChange: (cron: string) => void;
  /**
   * One more field to lay out on the SAME axis as the time of day — retention,
   * in every current call site. The picker owns that row's grid, so a caller
   * can't line its own field up with the time from outside.
   */
  trailing?: React.ReactNode;
  disabled?: boolean;
  /** Prefix for the generated control ids, so labels bind in a page with two pickers. */
  id?: string;
  /** The frequency field's own label — the picker renders it, to stay aligned with `trailing`. */
  label?: React.ReactNode;
  info?: React.ReactNode;
  /**
   * The zone the expression is read in. UTC for backups and docker cleanup,
   * which have no zone of their own; a cron job passes its own, and then every
   * label, the description and the next-run resolution must agree - a time field
   * labelled UTC on a schedule that fires at 03:00 in Rome is a plain lie.
   */
  timezone?: string;
}) {
  const [parts, setParts] = React.useState<ScheduleParts>(
    () => partsFromCron(value) ?? DEFAULT_PARTS,
  );
  // An expression the controls can't express opens straight in the escape hatch.
  const [custom, setCustom] = React.useState(() => partsFromCron(value) === null);

  const mode: ScheduleMode = custom ? "custom" : parts.mode;
  const valid = isValidSchedule(value);
  const description = describeCron(value, { timeZone: timezone });

  // The next run is resolved after hydration only: it is formatted in the
  // READER's timezone off the READER's clock, neither of which the server has,
  // so rendering it during SSR would paint the host's answer and then disagree.
  // `useSyncExternalStore` gives the flag with no effect and no cascading render
  // — the value flips exactly once, server → client.
  const hydrated = React.useSyncExternalStore(NEVER_CHANGES, onClient, onServer);
  const nextRun = hydrated ? nextCronRunInZone(value, new Date(), timezone) : null;

  function apply(next: ScheduleParts) {
    setParts(next);
    onChange(cronFromParts(next));
  }

  function pickMode(next: string) {
    if (next === "custom") {
      // Keep the current expression as the starting point — switching to
      // Advanced hands the user the cron their preset produced, to tweak.
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
    // A cleared `type="time"` input reports "" — ignore it rather than emit NaN.
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) return;
    apply({ ...parts, hour, minute });
  }

  const needsTime = mode === "daily" || mode === "weekly" || mode === "monthly";

  // The one follow-up the chosen frequency needs BESIDES a time, if any. It
  // shares the first row with the frequency itself so the second row is always
  // the "when / how long" pair.
  const dayField =
    mode === "weekly" ? (
      <div className="space-y-2">
        <FieldLabel htmlFor={`${id}-weekday`} info="Which day of the week it runs on.">
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
          info={`Which day of the month it runs on. Stops at ${MAX_MONTH_DAY} on purpose — a later day would silently skip the months that don't have it.`}
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
    // One rhythm, matching the dialogs this sits in: gap-4 between field rows,
    // space-y-2 between a label, its control and the note that explains it.
    <div className="grid gap-4">
      {/* Row 1 — how often, plus the day that frequency has to pin down. */}
      <div className={dayField ? "grid gap-4 sm:grid-cols-2" : "grid gap-4"}>
        <div className="space-y-2">
          <FieldLabel htmlFor={id} info={info}>
            {label}
          </FieldLabel>
          <Select value={mode} onValueChange={pickMode} disabled={disabled}>
            <SelectTrigger id={id}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GROUPS.map((group) => (
                <SelectGroup key={group}>
                  <SelectLabel>{group}</SelectLabel>
                  {SCHEDULE_OPTIONS.filter((o) => o.group === group).map((o) => (
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
          {/* The raw expression belongs to the frequency field — it IS the
              frequency, spelled out — so it sits in that cell, not on its own row. */}
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

      {/* Row 2 — the time of day, on the same axis as whatever the caller pairs
          with it (retention, in every current call site). Two columns even when
          only one is filled, so a lone field keeps a field's width. The summary
          reads the whole schedule, so it hangs off this last row. */}
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
          <p className="text-xs text-muted-foreground">
            {description ?? "Custom schedule"}
            {nextRun && (
              <>
                {" · next run "}
                <span className="text-foreground">{formatLocal(nextRun)}</span>
                {" your time"}
              </>
            )}
          </p>
        ) : (
          <p className="text-xs text-destructive">
            Not a valid cron expression. Use 5 fields — minute hour day month weekday.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * A stored schedule, read back as words — the display twin of the picker. Lists
 * show what a schedule *does* ("Weekly, Wed 03:00 UTC"), with the expression
 * itself kept in the tooltip for whoever wants it. An expression the vocabulary
 * doesn't cover has nothing to say in words, so it shows as the cron it is.
 */
export function ScheduleLabel({
  cron,
  timezone = "UTC",
}: {
  cron: string;
  /** The zone the expression is read in - see {@link SchedulePicker}. */
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

/** The next run, in the reader's own timezone — e.g. "Sat 2 Aug, 05:00". */
function formatLocal(at: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(at);
}
