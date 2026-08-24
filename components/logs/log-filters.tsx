"use client";

import * as React from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FacetMenu, type EnvFacet } from "@/components/env/env-filters";
import { stripAnsi } from "@/lib/ansi";
import { LEVEL_MENU_CLASS, LEVEL_MENU_LABEL } from "@/lib/log-levels";
import { cn } from "@/lib/utils";
import type { LogLevel } from "@/lib/types";

/**
 * Search + level filtering, shared by every log console: the live runtime pane,
 * the build-log stream, and the deployments Logs page. All three grew their own
 * half of it — the deployments page had a search box and six hand-rolled toggle
 * pills, the live pane had neither — and this is the one implementation.
 *
 * The level menu is `FacetMenu` from the env toolbar, unchanged. It already
 * carries the multi-select popover, the per-option row counts, the greyed-out
 * zero-count option and the "Level · 3" trigger summary; a second one written
 * here would only be a worse copy. What is NOT reused is `useEnvFilters`, whose
 * `FilterableVar` constraint wants a `key` and an `updatedAt` that a log line
 * has neither of, and whose full-table recompute is the wrong shape for a
 * stream that appends a chunk every few hundred milliseconds.
 */

export interface FilterableLogLine {
  level: LogLevel;
  text: string;
}

/** `levels: []` means "every level", the same convention `EnvFilterState` uses:
 *  an empty pick is the absence of a filter, not a filter that excludes all. */
export interface LogFilterState {
  q: string;
  levels: string[];
}

export const EMPTY_LOG_FILTERS: LogFilterState = { q: "", levels: [] };

/** Levels a runtime container log can be given. `command` is producer-only —
 *  nothing infers it — so it is not offered where nothing can carry it. */
export const RUNTIME_LEVELS: LogLevel[] = [
  "error",
  "warn",
  "success",
  "info",
  "debug",
];

/** Levels a build log can carry, most-severe first so the menu reads as a scale. */
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
      // The menu says "Error", not "ERROR": the shouted, fixed-width form belongs
      // to the pill on a line of monospace output, not to a dropdown row. And it
      // wears the level's own colour, because severity is what you are picking.
      label: LEVEL_MENU_LABEL[value] ?? value,
      labelClassName: LEVEL_MENU_CLASS[value],
    })),
    match: (row, value) => row.level === value,
  };
}

/**
 * Does a line match the needle? The raw text is tested first because it almost
 * always answers, and stripping ANSI off every line on every keystroke is the
 * expensive half. The stripped text is the fallback for the case the fast path
 * cannot see: a needle straddling an escape sequence, e.g. searching "connect"
 * across a `\x1b[31m` sitting between "con" and "nect".
 */
function matchesQuery(text: string, needle: string): boolean {
  return (
    text.toLowerCase().includes(needle) ||
    stripAnsi(text).toLowerCase().includes(needle)
  );
}

export function useLogFilters<T extends FilterableLogLine>(
  rows: T[],
  levels: LogLevel[] = RUNTIME_LEVELS,
) {
  const [state, setState] = React.useState<LogFilterState>(EMPTY_LOG_FILTERS);
  const facet = React.useMemo(() => levelFacet(levels), [levels]);

  const needle = state.q.trim().toLowerCase();
  const picked = state.levels;

  // Rows the SEARCH leaves. Split out from the level pass because the counts
  // below have to be "how many would picking this level leave", which means
  // measuring against the other filters applied and this one not.
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
    /** True when the pane is showing a subset, so an empty result can say why. */
    filtering: needle !== "" || picked.length > 0,
    /** The needle, for `LogRow`'s `highlight` — trimmed, but not lowercased. */
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
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
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
  // `FacetMenu`'s trigger is `flex-1` so it fills a toolbar cell; a log toolbar
  // wants it to stay the width of its own label instead of eating the row.
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
