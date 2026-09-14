"use client";

import * as React from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FacetMenu } from "@/components/env/env-filters/facet-menu";
import type { EnvFacet } from "@/components/env/env-filters/types";
import { stripAnsi } from "@/lib/ansi";
import { LEVEL_MENU_CLASS, LEVEL_MENU_LABEL } from "@/lib/log-levels";
import { cn } from "@/lib/utils";
import type { LogLevel } from "@/lib/types/deployment";

export interface FilterableLogLine {
  level: LogLevel;
  text: string;
}

// LogFilterState - `levels: []` means every level: an empty pick is the absence of a filter, not one that excludes all.
export interface LogFilterState {
  q: string;
  levels: string[];
}

export const EMPTY_LOG_FILTERS: LogFilterState = { q: "", levels: [] };

// RUNTIME_LEVELS - `command` is producer-only and nothing infers it, so it is not offered here.
export const RUNTIME_LEVELS: LogLevel[] = [
  "error",
  "warn",
  "success",
  "info",
  "debug",
];

// BUILD_LEVELS - most-severe first, so the menu reads as a scale.
export const BUILD_LEVELS: LogLevel[] = [
  "error",
  "warn",
  "success",
  "info",
  "debug",
  "command",
];

function levelFacet(levels: LogLevel[]): EnvFacet<FilterableLogLine> {
  return {
    id: "level",
    label: "Level",
    allLabel: "All levels",
    icon: SlidersHorizontal,
    options: levels.map((value) => ({
      value,
      label: LEVEL_MENU_LABEL[value] ?? value,
      labelClassName: LEVEL_MENU_CLASS[value],
    })),
    match: (row, value) => row.level === value,
  };
}

// Raw text first because it almost always answers; stripping ANSI only catches a needle straddling an escape.
function matchesQuery(text: string, needle: string): boolean {
  return (
    text.toLowerCase().includes(needle) ||
    stripAnsi(text).toLowerCase().includes(needle)
  );
}

// Not `useEnvFilters`: that hook wants a `key` and an `updatedAt` a log line does not have.
export function useLogFilters<T extends FilterableLogLine>(
  rows: T[],
  levels: LogLevel[] = RUNTIME_LEVELS,
) {
  const [state, setState] = React.useState<LogFilterState>(EMPTY_LOG_FILTERS);
  const facet = React.useMemo(() => levelFacet(levels), [levels]);

  const needle = state.q.trim().toLowerCase();
  const picked = state.levels;

  // Split out from the level pass because each count must be "how many would picking this level leave".
  const searched = React.useMemo(
    () => (needle ? rows.filter((r) => matchesQuery(r.text, needle)) : rows),
    [rows, needle],
  );

  const shown = React.useMemo(
    () =>
      picked.length === 0
        ? searched
        : searched.filter((r) => picked.includes(r.level)),
    [searched, picked],
  );

  const counts = React.useMemo(() => {
    const out: Record<string, number> = {};
    for (const level of levels) out[level] = 0;
    for (const row of searched) {
      if (row.level in out) out[row.level]! += 1;
    }
    return out;
  }, [searched, levels]);

  return {
    state,
    setState,
    facet,
    shown,
    counts,
    filtering: needle !== "" || picked.length > 0,
    // For `LogRow`'s `highlight`: trimmed, but not lowercased.
    highlight: state.q.trim(),
  };
}

export function LogSearch({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("relative min-w-0 flex-1", className)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search logs"
        aria-label="Search logs"
        className="h-9 pl-9"
      />
    </div>
  );
}

export function LogLevelFilter({
  facet,
  values,
  counts,
  onChange,
  className,
}: {
  facet: EnvFacet<FilterableLogLine>;
  values: string[];
  counts?: Record<string, number>;
  onChange: (values: string[]) => void;
  className?: string;
}) {
  // `FacetMenu`'s trigger is `flex-1` and would eat the row, so its width is pinned here.
  return (
    <div className={cn("flex w-36 shrink-0 items-center", className)}>
      <FacetMenu
        facet={facet}
        values={values}
        counts={counts}
        onChange={onChange}
      />
    </div>
  );
}
