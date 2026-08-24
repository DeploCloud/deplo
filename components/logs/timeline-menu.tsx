"use client";

import * as React from "react";
import { Check, Clock } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * How far back the live stream reaches, plus the two things about the timestamp
 * column that only make sense next to it.
 *
 * A menu of its own rather than another facet on the toolbar, because it is not
 * a filter: picking a range REOPENS the stream with a new `--since`, it does not
 * hide rows already on screen. Filters narrow what you have; this changes what
 * you asked for.
 *
 * The ceiling comes from the instance setting, and the last row is generated
 * from it rather than hard-coded: an admin who sets 7 days gets "Last 7 days"
 * here, and one who sets 1 gets nothing extra, because "Last day" already is
 * the ceiling. Docker rotates its log files by SIZE, so this is a bound on what
 * may be ASKED for, never a promise the host still has it — which is why an
 * empty result says the host rotated them rather than "no logs".
 */

/** Minutes back from now. `0` would mean "everything", which is deliberately not
 *  offered: a container that has been up for a year would replay all of it. */
export interface LogTimeline {
  sinceMinutes: number;
  timestamps: boolean;
  format: "absolute" | "relative";
}

const MINUTES_PER_DAY = 60 * 24;

export const DEFAULT_TIMELINE: LogTimeline = {
  sinceMinutes: 30,
  timestamps: true,
  format: "absolute",
};

const BASE_RANGES = [
  { minutes: 30, label: "Last 30 minutes" },
  { minutes: 60, label: "Last hour" },
  { minutes: MINUTES_PER_DAY, label: "Last day" },
];

/** The offered ranges for a given ceiling. The ceiling's own row is appended
 *  only when it says something the three fixed rows do not. */
export function rangesFor(maxDays: number): { minutes: number; label: string }[] {
  const capped = BASE_RANGES.filter((r) => r.minutes <= maxDays * MINUTES_PER_DAY);
  const ranges = capped.length > 0 ? capped : [BASE_RANGES[0]!];
  if (maxDays > 1) {
    ranges.push({
      minutes: maxDays * MINUTES_PER_DAY,
      label: `Last ${maxDays} days`,
    });
  }
  return ranges;
}

export function TimelineMenu({
  value,
  onChange,
  maxDays,
  disabled = false,
  disabledReason,
}: {
  value: LogTimeline;
  onChange: (next: LogTimeline) => void;
  /** The instance's "Max log range" setting, in days. */
  maxDays: number;
  /** The server's agent predates the time-range fields on FollowLogs. */
  disabled?: boolean;
  disabledReason?: string;
}) {
  const ranges = rangesFor(maxDays);
  const current =
    ranges.find((r) => r.minutes === value.sinceMinutes) ?? ranges[0]!;

  const trigger = (
    <button
      type="button"
      disabled={disabled}
      aria-label="Time range"
      className={cn(
        "flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm transition-colors",
        "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "text-muted-foreground hover:text-foreground",
      )}
    >
      <Clock className="size-3.5 shrink-0" />
      <span className="truncate">{current.label}</span>
    </button>
  );

  // A disabled trigger swallows pointer events, so the tooltip has to wrap it
  // rather than sit on it — otherwise the one control that needs to explain
  // itself is the one that cannot.
  if (disabled) {
    return (
      <SimpleTooltip
        content={
          disabledReason ??
          "Update this server's agent to filter logs by time range"
        }
      >
        <span className="inline-flex">{trigger}</span>
      </SimpleTooltip>
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1">
        {ranges.map((range) => {
          const on = range.minutes === current.minutes;
          return (
            <button
              key={range.minutes}
              type="button"
              onClick={() => onChange({ ...value, sinceMinutes: range.minutes })}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                on && "font-medium",
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {on && <Check className="size-3.5" />}
              </span>
              {range.label}
            </button>
          );
        })}

        <div className="my-1 h-px bg-border" />

        <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
          <span>Show timestamps</span>
          <Switch
            checked={value.timestamps}
            onCheckedChange={(timestamps) => onChange({ ...value, timestamps })}
            aria-label="Show timestamps"
          />
        </div>

        {value.timestamps && (
          <div className="flex items-center justify-between gap-2 px-2 pb-1.5 text-sm">
            <span className="text-muted-foreground">Format</span>
            <div className="flex rounded-md border border-input p-0.5">
              {(["absolute", "relative"] as const).map((format) => (
                <button
                  key={format}
                  type="button"
                  onClick={() => onChange({ ...value, format })}
                  aria-pressed={value.format === format}
                  className={cn(
                    "cursor-pointer rounded px-2 py-0.5 text-xs capitalize transition-colors",
                    value.format === format
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {format}
                </button>
              ))}
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
