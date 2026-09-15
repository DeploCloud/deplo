"use client";

import * as React from "react";
import { CalendarDays, Check, ChevronDown } from "lucide-react";
import type { DateRange } from "react-day-picker";

import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ACTIVITY_RANGES, type ActivityParams } from "@/lib/activity-filter";
import { cn } from "@/lib/utils";

const ALL_TIME = "All time";

function toDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fromDay(day: string): Date | undefined {
  return day ? new Date(`${day}T00:00:00.000Z`) : undefined;
}

function summary(params: ActivityParams): string {
  const preset = ACTIVITY_RANGES.find((r) => r.value === params.range);
  if (preset) return preset.label;
  if (params.from && params.to) return `${params.from} to ${params.to}`;
  if (params.from) return `Since ${params.from}`;
  if (params.to) return `Until ${params.to}`;
  return ALL_TIME;
}

export function DateRangeFilter({
  params,
  onChange,
}: {
  params: ActivityParams;
  onChange: (next: Partial<ActivityParams>) => void;
}) {
  const on = params.range !== "" || params.from !== "" || params.to !== "";
  const selected: DateRange | undefined =
    params.from || params.to
      ? { from: fromDay(params.from), to: fromDay(params.to) }
      : undefined;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Filter by date"
          title={`Date: ${summary(params)}`}
          className={cn(
            "flex h-9 min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm shadow-sm transition-colors",
            "focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background focus:outline-none",
            on
              ? "border-primary/60 bg-primary-wash text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <CalendarDays className="size-3.5 shrink-0" />
          <span className="truncate">{summary(params)}</span>
          <ChevronDown className="ml-auto size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex w-auto gap-1 p-1">
        <div className="w-40 shrink-0 space-y-0.5 border-r border-border pr-1">
          {[{ value: "", label: ALL_TIME }, ...ACTIVITY_RANGES].map((r) => (
            <button
              key={r.value}
              type="button"
              onClick={() => onChange({ range: r.value, from: "", to: "" })}
              className={cn(
                "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                params.range === r.value &&
                  !params.from &&
                  !params.to &&
                  "font-medium",
              )}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {params.range === r.value && !params.from && !params.to && (
                  <Check className="size-3.5" />
                )}
              </span>
              {r.label}
            </button>
          ))}
        </div>
        <Calendar
          mode="range"
          numberOfMonths={1}
          timeZone="UTC"
          defaultMonth={selected?.from}
          selected={selected}
          disabled={{ after: new Date() }}
          onSelect={(next) =>
            onChange({
              range: "",
              from: next?.from ? toDay(next.from) : "",
              to: next?.to ? toDay(next.to) : "",
            })
          }
        />
      </PopoverContent>
    </Popover>
  );
}
