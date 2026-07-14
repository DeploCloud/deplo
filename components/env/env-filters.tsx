"use client";

import * as React from "react";
import {
  ArrowUpDown,
  Check,
  ChevronDown,
  Clock,
  KeyRound,
  Search,
  Share2,
  UserRound,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";
import type { VarAuthor } from "@/lib/types";

/** The option value for "this row has no such thing" (no project, no author…). */
export const FACET_NONE = "__none__";

/** Sort over the "Last modified" column, plus an A→Z escape hatch by key. */
export type EnvSort = "recent" | "oldest" | "key";

export interface EnvFilterState {
  q: string;
  sort: EnvSort;
  /**
   * facet id → the option values picked in it. Every facet is MULTI-select:
   * values inside one facet are OR-ed ("modified by Ada **or** Linus"), and the
   * facets themselves are AND-ed ("…**and** secret"). An absent/empty list is a
   * facet that isn't filtering.
   */
  facets: Record<string, string[]>;
}

/** Recently-modified first: the column the filters were added to surface. */
export const EMPTY_ENV_FILTERS: EnvFilterState = {
  q: "",
  sort: "recent",
  facets: {},
};

/** Row shape every facet can count on. Any variable DTO satisfies it. */
export interface FilterableVar {
  key: string;
  type: "plain" | "secret";
  updatedAt: string;
  createdBy?: VarAuthor | null;
  updatedBy?: VarAuthor | null;
}

/** One choice inside a facet. `hint` disambiguates repeated labels ("Production"
 *  exists in every project), and is shown greyed next to the label. */
export interface FacetOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * One filter dropdown: what it's called, what you may pick, and what picking it
 * means. The predicate is the whole point — a tab knows how its own rows relate
 * to a project / an environment / an app, and the toolbar never has to.
 *
 * A facet with fewer than two options is HIDDEN (a menu with one real choice is
 * noise) unless it is `persistent` or currently picked — a filter you can't see
 * is a filter you can't turn off.
 */
export interface EnvFacet<T> {
  id: string;
  /** The trigger's prefix, e.g. "Environment" → reads "Environment: Production". */
  label: string;
  /** The "off" row at the top of the menu, e.g. "All environments". */
  allLabel: string;
  info?: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
  options: FacetOption[];
  match: (row: T, value: string) => boolean;
  /** Show it even with a single option — a filter a team EXPECTS to find (who
   *  changed this?) must not vanish just because one person changed everything. */
  persistent?: boolean;
}

/** How an author reads in the menu — the display name, or the handle when a user
 *  never set one. Also the sort key, so the list reads in the order shown. */
function authorLabel(author: VarAuthor): string {
  return author.name.trim() || author.username;
}

function timestamp(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/** Whoever the "Modified by" column shows: the last editor, else the creator. */
export function lastEditor(row: FilterableVar): VarAuthor | null {
  return row.updatedBy ?? row.createdBy ?? null;
}

/** Human copy for how a shared variable reaches an app — the `via` layer. Shared
 *  by the Source facet and by the "Shared · …" badges on every variables table. */
export const VIA_LABEL: Record<string, string> = {
  teamWide: "Team-wide",
  environment: "Environment",
  project: "Project",
  link: "Linked",
};

/* ------------------------------------------------------------------ */
/* Filtering                                                           */
/* ------------------------------------------------------------------ */

function matchesFilters<T extends FilterableVar>(
  row: T,
  f: EnvFilterState,
  facets: EnvFacet<T>[],
  extraHaystack?: (row: T) => string,
  /** Ignore this facet — how a facet counts its OWN options (see {@link facetCounts}). */
  skipFacetId?: string,
): boolean {
  const q = f.q.trim().toLowerCase();
  if (q) {
    const extra = extraHaystack?.(row) ?? "";
    if (!`${row.key} ${extra}`.toLowerCase().includes(q)) return false;
  }
  for (const facet of facets) {
    if (facet.id === skipFacetId) continue;
    const values = f.facets[facet.id];
    if (!values?.length) continue;
    // OR within one facet: picking Ada AND Linus means "either of them", not
    // "both of them" — no row could ever satisfy the latter.
    if (!values.some((value) => facet.match(row, value))) return false;
  }
  return true;
}

/**
 * Narrow + sort a page of variables. Filtering is client-side over rows that are
 * already loaded (no round-trip), matching `deployments-table.tsx`.
 *
 * `extraHaystack` widens the search beyond the key: the aggregate page passes the
 * App name, so searching "storefront" finds that app's variables.
 */
export function applyEnvFilters<T extends FilterableVar>(
  rows: T[],
  f: EnvFilterState,
  facets: EnvFacet<T>[] = [],
  extraHaystack?: (row: T) => string,
): T[] {
  // `filter` already returns a fresh array, so the sort below never mutates the
  // caller's rows.
  const out = rows.filter((row) =>
    matchesFilters(row, f, facets, extraHaystack),
  );

  // A bulk write (.env import / editor save) stamps every row with the SAME
  // `updatedAt`, so a timestamp sort alone would order those rows arbitrarily —
  // break the tie on the key to keep the table stable across re-renders.
  out.sort((a, b) => {
    if (f.sort === "key") return a.key.localeCompare(b.key);
    const delta = timestamp(b.updatedAt) - timestamp(a.updatedAt);
    if (delta !== 0) return f.sort === "oldest" ? -delta : delta;
    return a.key.localeCompare(b.key);
  });
  return out;
}

/**
 * How many rows each option would leave standing — the number next to every
 * choice in the menus.
 *
 * A facet counts its own options against the rows the OTHER filters left (it
 * ignores itself), which is what makes the menu answer "and what if I ticked
 * this one too?" rather than "0" for every box you haven't ticked.
 */
export function facetCounts<T extends FilterableVar>(
  rows: T[],
  f: EnvFilterState,
  facets: EnvFacet<T>[],
  extraHaystack?: (row: T) => string,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const facet of facets) {
    // Seeded at 0 so an option nothing matches still reports a count — that zero
    // is what greys it out in the menu instead of leaving it mute.
    const counts: Record<string, number> = {};
    for (const opt of facet.options) counts[opt.value] = 0;
    for (const row of rows) {
      if (!matchesFilters(row, f, facets, extraHaystack, facet.id)) continue;
      // A row may satisfy SEVERAL options of one facet (a variable shared both
      // team-wide and with an app) — it counts under each.
      for (const opt of facet.options) {
        if (facet.match(row, opt.value)) counts[opt.value] += 1;
      }
    }
    out[facet.id] = counts;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The facets every variables table shares                             */
/* ------------------------------------------------------------------ */

/** Plain vs secret. */
export function typeFacet<T extends FilterableVar>(rows: T[]): EnvFacet<T> {
  const seen = new Set(rows.map((r) => r.type));
  return {
    id: "type",
    label: "Type",
    allLabel: "All types",
    icon: KeyRound,
    info: "Secret values are encrypted at rest and never shown again; plain values are readable.",
    options: (["plain", "secret"] as const)
      .filter((t) => seen.has(t))
      .map((t) => ({ value: t, label: t === "plain" ? "Plain" : "Secret" })),
    match: (row, value) => row.type === value,
  };
}

/**
 * Who touched the variable LAST — the person in the "Modified by" column. Tick
 * several people to see everything any of them changed.
 *
 * `persistent`: this one is always on the toolbar. It is the filter people go
 * looking for ("what did Ada change?"), and hiding it on a team where one person
 * happens to have written everything reads as a missing feature, not as tidiness.
 */
export function editorFacet<T extends FilterableVar>(rows: T[]): EnvFacet<T> {
  const byId = new Map<string, VarAuthor>();
  // Rows written before authorship was recorded (and shared rows whose editor
  // left the team) carry no author — they get their own bucket rather than
  // silently dropping out of every person's filter.
  let anonymous = false;
  for (const row of rows) {
    const author = lastEditor(row);
    if (author) {
      if (!byId.has(author.id)) byId.set(author.id, author);
    } else {
      anonymous = true;
    }
  }
  const options: FacetOption[] = [
    ...[...byId.values()]
      .sort((a, b) => authorLabel(a).localeCompare(authorLabel(b)))
      .map((a) => ({ value: a.id, label: authorLabel(a) })),
    ...(anonymous ? [{ value: FACET_NONE, label: "Unknown" }] : []),
  ];
  return {
    id: "editor",
    label: "Modified by",
    allLabel: "Anyone",
    icon: UserRound,
    persistent: true,
    info: "Who last changed the variable — the user in the “Modified by” column. Pick more than one to see everything any of them touched.",
    options,
    match: (row, value) =>
      value === FACET_NONE
        ? lastEditor(row) == null
        : lastEditor(row)?.id === value,
  };
}

const DAY = 86_400_000;
const WINDOWS: { value: string; label: string; within: number }[] = [
  { value: "24h", label: "Last 24 hours", within: DAY },
  { value: "7d", label: "Last 7 days", within: 7 * DAY },
  { value: "30d", label: "Last 30 days", within: 30 * DAY },
];

/** When the variable was last modified, as time windows over the same column the
 *  sort orders by. */
export function updatedFacet<T extends FilterableVar>(): EnvFacet<T> {
  // Read once per build (the facet is memoised on the rows), so every option of
  // one render measures against the same "now".
  const now = Date.now();
  return {
    id: "updated",
    label: "Updated",
    allLabel: "Any time",
    icon: Clock,
    options: [
      ...WINDOWS.map((w) => ({ value: w.value, label: w.label })),
      { value: "older", label: "More than 30 days ago" },
    ],
    match: (row, value) => {
      const age = now - timestamp(row.updatedAt);
      const window = WINDOWS.find((w) => w.value === value);
      return window ? age <= window.within : age > 30 * DAY;
    },
  };
}

/** A row that is either the app's own variable or a shared one, and — when
 *  shared — the layer it arrives through. */
export interface SourceRow {
  kind: "standalone" | "shared";
  via?: string;
}

/** Standalone vs shared, and for shared rows WHICH sharing layer brought it in. */
export function sourceFacet<T extends FilterableVar & SourceRow>(
  rows: T[],
): EnvFacet<T> {
  const vias = new Set(
    rows.flatMap((r) => (r.kind === "shared" && r.via ? [r.via] : [])),
  );
  const options: FacetOption[] = [
    ...(rows.some((r) => r.kind === "standalone")
      ? [{ value: "standalone", label: "Standalone" }]
      : []),
    ...(["teamWide", "project", "environment", "link"] as const)
      .filter((via) => vias.has(via))
      .map((via) => ({
        value: `shared:${via}`,
        label: `Shared · ${VIA_LABEL[via]}`,
      })),
  ];
  return {
    id: "source",
    label: "Source",
    allLabel: "All sources",
    icon: Share2,
    info: "Where the variable comes from: written on the app itself, or shared with it team-wide, through its project, through its environment, or by a direct link.",
    options,
    match: (row, value) =>
      value === "standalone"
        ? row.kind === "standalone"
        : row.kind === "shared" && `shared:${row.via}` === value,
  };
}

/* ------------------------------------------------------------------ */
/* The hook + the toolbar                                              */
/* ------------------------------------------------------------------ */

/**
 * Own the filter state for one variables table: the rows that survive it, and
 * the per-option counts the toolbar shows. `clear` keeps the SORT — an ordering
 * is not a filter.
 */
export function useEnvFilters<T extends FilterableVar>(
  rows: T[],
  facets: EnvFacet<T>[],
  extraHaystack?: (row: T) => string,
) {
  const [state, setState] = React.useState<EnvFilterState>(EMPTY_ENV_FILTERS);

  const shown = React.useMemo(
    () => applyEnvFilters(rows, state, facets, extraHaystack),
    // `extraHaystack` is a per-render arrow at every call site; depending on it
    // would recompute on every render and pin nothing down. The rows it reads
    // are in `rows`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, state, facets],
  );
  const counts = React.useMemo(
    () => facetCounts(rows, state, facets, extraHaystack),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, state, facets],
  );

  const clear = React.useCallback(
    () => setState((s) => ({ ...EMPTY_ENV_FILTERS, sort: s.sort })),
    [],
  );

  return { state, setState, clear, shown, counts };
}

/**
 * The one search / filter / sort toolbar every variables table wears. Fully
 * controlled and fully declarative: the tab hands it the facets that make sense
 * there (a per-app table has no Project filter; the Shared tab has no Source
 * one) and the toolbar renders them the same way, in the same place, with the
 * same clear-everything button and the same "showing X of Y" line.
 *
 * Two rows: the search + what it left standing + the sort (+ the page's own
 * action, if it has one), then ONE row of filter dropdowns — on a desktop they
 * share that row and shrink to fit rather than wrapping into a stack that pushes
 * the table down the page.
 */
export function EnvFilters<T extends FilterableVar>({
  state,
  onChange,
  onClear,
  facets,
  counts,
  total,
  shown,
  actions,
  className,
}: {
  state: EnvFilterState;
  onChange: (next: EnvFilterState) => void;
  /** Reset every filter but keep the sort — {@link useEnvFilters}'s `clear`. */
  onClear: () => void;
  facets: EnvFacet<T>[];
  /** Per-option row counts — {@link facetCounts}. */
  counts?: Record<string, Record<string, number>>;
  /** Rows before filtering / after it: the "Showing 8 of 40" line. */
  total?: number;
  shown?: number;
  /**
   * The table's own action (an app's "Add"), rendered LAST on the search row —
   * after the sort. It sits here rather than in the page header because the row
   * of filter dropdowns below needs the full width, and a header button would
   * leave the toolbar's own right edge empty.
   */
  actions?: React.ReactNode;
  className?: string;
}) {
  const picked = Object.values(state.facets).filter((v) => v?.length).length;
  const hasFilter = Boolean(state.q.trim()) || picked > 0;

  // A one-choice facet is noise — unless it declares itself persistent, or is
  // already filtering (the last secret gets deleted while Type=Secret is on).
  const visible = facets.filter(
    (f) =>
      f.options.length >= 2 ||
      f.persistent ||
      Boolean(state.facets[f.id]?.length),
  );

  const narrowed = total != null && shown != null && shown !== total;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={state.q}
            onChange={(e) => onChange({ ...state, q: e.target.value })}
            placeholder="Search variables…"
            aria-label="Search variables"
            className="h-9 pl-9"
          />
        </div>

        {/* The slot is RESERVED, never conditionally mounted: this button turns up
            on the first keystroke, and inserting it into a wrapping flex row would
            shove the controls around it while the cursor is still in the search
            box. `invisible` also takes it out of the tab order and the a11y tree,
            so an idle toolbar exposes nothing to clear. */}
        <Button
          variant="ghost"
          size="sm"
          disabled={!hasFilter}
          className={cn("shrink-0", !hasFilter && "invisible")}
          onClick={onClear}
        >
          Clear filters
        </Button>

        {total != null && shown != null && (
          <p
            aria-live="polite"
            className={cn(
              "shrink-0 whitespace-nowrap text-xs",
              narrowed ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {narrowed
              ? `Showing ${shown} of ${total} variables`
              : `${total} variable${total === 1 ? "" : "s"}`}
          </p>
        )}

        <Select
          value={state.sort}
          onValueChange={(v) => onChange({ ...state, sort: v as EnvSort })}
        >
          <SelectTrigger
            className="w-[190px] shrink-0"
            aria-label="Sort variables"
          >
            {/* `flex!` is load-bearing: SelectTrigger applies `[&>span]:line-clamp-1`
                to its direct-child spans, whose `display:-webkit-box` outranks a
                plain `flex` class (the `>span` selector is more specific) and would
                stack the icon above the value. The important modifier keeps them on
                one row. */}
            <span className="flex! items-center gap-2">
              <ArrowUpDown className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-muted-foreground">Sort:</span>
              <SelectValue />
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="recent">Recently modified</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
            <SelectItem value="key">Key (A–Z)</SelectItem>
          </SelectContent>
        </Select>

        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>

      {visible.length > 0 && (
        // One row on a desktop: `lg:flex-nowrap` + a flexible basis lets the
        // dropdowns share the width and truncate their own labels. Below `lg`
        // they wrap, two or three to a line.
        <div className="flex flex-wrap gap-2 lg:flex-nowrap">
          {visible.map((facet) => (
            <FacetPicker
              key={facet.id}
              facet={facet}
              values={state.facets[facet.id] ?? []}
              counts={counts?.[facet.id]}
              onChange={(values) =>
                onChange({
                  ...state,
                  facets: { ...state.facets, [facet.id]: values },
                })
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One facet, as a multi-select menu: tick as many options as you like (they are
 * OR-ed), see how many rows each one would leave, and clear the whole facet from
 * the row at the top. The trigger states the filter in its own words —
 * "Modified by: Ada" / "Modified by: 3 selected".
 */
function FacetPicker<T>({
  facet,
  values,
  counts,
  onChange,
}: {
  facet: EnvFacet<T>;
  values: string[];
  counts?: Record<string, number>;
  onChange: (values: string[]) => void;
}) {
  const Icon = facet.icon;
  const on = values.length > 0;
  const empty = facet.options.length === 0;
  const first = facet.options.find((o) => o.value === values[0]);
  // Compact by design: six of these share one desktop row, so a permanent
  // "Environment:" prefix would leave no room for the value. Idle, the trigger IS
  // the facet's name; with one pick it becomes the pick; with several, the name
  // plus how many. The full picture is one click away, in the menu.
  const summary = empty
    ? `${facet.label} — none`
    : values.length === 0
      ? facet.label
      : values.length === 1
        ? (first?.label ?? facet.label)
        : `${facet.label} · ${values.length}`;

  function toggle(value: string) {
    onChange(
      values.includes(value)
        ? values.filter((v) => v !== value)
        : [...values, value],
    );
  }

  return (
    <div className="flex min-w-[10rem] flex-1 items-center gap-1 lg:min-w-0">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={empty}
            aria-label={`Filter by ${facet.label.toLowerCase()}`}
            title={
              on
                ? `${facet.label}: ${facet.options
                    .filter((o) => values.includes(o.value))
                    .map((o) => o.label)
                    .join(", ")}`
                : `Filter by ${facet.label.toLowerCase()}`
            }
            className={cn(
              "flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-transparent px-3 text-sm shadow-sm transition-colors",
              "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background",
              "disabled:cursor-not-allowed disabled:opacity-50",
              on
                ? "border-primary/60 bg-primary/[0.06] text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {Icon && <Icon className="size-3.5 shrink-0" />}
            <span className="truncate">{summary}</span>
            <ChevronDown className="ml-auto size-4 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-1">
          <button
            type="button"
            onClick={() => onChange([])}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
              !on && "font-medium",
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {!on && <Check className="size-3.5" />}
            </span>
            {facet.allLabel}
          </button>
          <div className="my-1 h-px bg-border" />
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {facet.options.map((opt) => {
              const checked = values.includes(opt.value);
              const n = counts?.[opt.value];
              return (
                <label
                  key={opt.value}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent",
                    // Ticking it would add nothing — shown, so you can see the
                    // option exists, greyed, so you know why it's pointless.
                    n === 0 && !checked && "opacity-50",
                  )}
                >
                  <Checkbox
                    checked={checked}
                    onCheckedChange={() => toggle(opt.value)}
                  />
                  <span className="truncate">{opt.label}</span>
                  {opt.hint && (
                    <span className="truncate text-xs text-muted-foreground">
                      {opt.hint}
                    </span>
                  )}
                  {n != null && (
                    <span className="ml-auto pl-2 text-xs tabular-nums text-muted-foreground">
                      {n}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>
      {facet.info != null && (
        <InfoTip
          content={facet.info}
          className="shrink-0"
          label={`About the ${facet.label.toLowerCase()} filter`}
        />
      )}
    </div>
  );
}
