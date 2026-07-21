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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverAnchor,
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

/**
 * Row shape every facet can count on. Any variable DTO satisfies it — and so does
 * anything else with a name, a last-touched timestamp and an author, which is why
 * the App → Settings → Access credentials reuse this whole toolbar rather than
 * growing a second search/filter/sort of their own.
 *
 * `key` is the row's IDENTIFYING NAME — a variable's key, a basic-auth
 * credential's username. It is what the search box matches and what the A–Z sort
 * orders by.
 */
export interface FilterableVar {
  key: string;
  updatedAt: string;
  createdBy?: VarAuthor | null;
  updatedBy?: VarAuthor | null;
}

/** A {@link FilterableVar} that is plain-or-secret — what {@link typeFacet} needs.
 *  Split out so rows with no such distinction (credentials) still fit the kit. */
export interface TypedVar extends FilterableVar {
  type: "plain" | "secret";
}

/** One choice inside a facet. `hint` disambiguates repeated labels ("Production"
 *  exists in every project), and is shown greyed next to the label. `author`
 *  marks the option as a person — the menu then leads with their avatar. */
export interface FacetOption {
  value: string;
  label: string;
  hint?: string;
  author?: VarAuthor;
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
  /** Render the facet as an autocomplete: the toolbar control IS an input you
   *  type into, and the menu narrows live (people lists). */
  searchable?: boolean;
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
export function typeFacet<T extends TypedVar>(rows: T[]): EnvFacet<T> {
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
 * A people filter over one authorship column. Both the "Modified by" and the
 * "Added by" facets are this: the control is an autocomplete input (`searchable`)
 * and every person leads with their avatar, so a long team narrows by typing and
 * a face is recognised before a handle is read.
 *
 * `persistent` by default: a people filter is the one people go looking for
 * ("what did Ada change?"), and hiding it on a team where one person happens to
 * have written everything reads as a missing feature, not as tidiness.
 */
function authorFacet<T extends FilterableVar>(spec: {
  rows: T[];
  id: string;
  label: string;
  info: React.ReactNode;
  /** The authorship column this facet reads. */
  pick: (row: T) => VarAuthor | null;
  persistent?: boolean;
}): EnvFacet<T> {
  const { rows, pick } = spec;
  const byId = new Map<string, VarAuthor>();
  // Rows written before authorship was recorded (and shared rows whose editor
  // left the team) carry no author — they get their own bucket rather than
  // silently dropping out of every person's filter.
  let anonymous = false;
  for (const row of rows) {
    const author = pick(row);
    if (author) {
      if (!byId.has(author.id)) byId.set(author.id, author);
    } else {
      anonymous = true;
    }
  }
  const options: FacetOption[] = [
    ...[...byId.values()]
      .sort((a, b) => authorLabel(a).localeCompare(authorLabel(b)))
      .map((a) => ({
        value: a.id,
        label: authorLabel(a),
        // The handle disambiguates two "Ada"s — pointless when it IS the label.
        hint: a.name.trim() ? `@${a.username}` : undefined,
        author: a,
      })),
    ...(anonymous ? [{ value: FACET_NONE, label: "Unknown" }] : []),
  ];
  return {
    id: spec.id,
    label: spec.label,
    allLabel: "Anyone",
    icon: UserRound,
    persistent: spec.persistent ?? true,
    searchable: true,
    info: spec.info,
    options,
    match: (row, value) =>
      value === FACET_NONE ? pick(row) == null : pick(row)?.id === value,
  };
}

/**
 * Who touched the row LAST — the person in the "Modified by" column. Tick several
 * people to see everything any of them changed.
 */
export function editorFacet<T extends FilterableVar>(
  rows: T[],
  /** What the rows are, for the help text — "variable" (default) or e.g. "credential". */
  noun = "variable",
): EnvFacet<T> {
  return authorFacet({
    rows,
    id: "editor",
    label: "Modified by",
    pick: lastEditor,
    info: `Who last changed the ${noun} — the user in the “Modified by” column. Type a name straight into the box to narrow the list; pick more than one to see everything any of them touched.`,
  });
}

/**
 * Who CREATED the row, whatever happened to it since. The complement of
 * {@link editorFacet}: "who set this up?" and "who touched it last?" are
 * different questions, and on a shared credential both get asked.
 */
export function creatorFacet<T extends FilterableVar>(
  rows: T[],
  noun = "variable",
): EnvFacet<T> {
  return authorFacet({
    rows,
    id: "creator",
    label: "Added by",
    pick: (row) => row.createdBy ?? null,
    info: `Who originally added the ${noun}, even if someone else has changed it since. Type a name straight into the box to narrow the list.`,
    // NOT persistent, unlike "Modified by". On a table where one person added
    // everything this facet can only answer "yes, them" — it earns its place on
    // the toolbar the moment a second person has added something.
    persistent: false,
  });
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

/** A row that is either the app's own variable or a shared one it opted into. */
export interface SourceRow {
  kind: "standalone" | "shared";
}

/** Standalone vs shared. Shared always means "the app opted in" (ADR-0012), so
 *  there is no per-layer split left to filter on. */
export function sourceFacet<T extends FilterableVar & SourceRow>(
  rows: T[],
): EnvFacet<T> {
  const options: FacetOption[] = [
    ...(rows.some((r) => r.kind === "standalone")
      ? [{ value: "standalone", label: "Standalone" }]
      : []),
    ...(rows.some((r) => r.kind === "shared")
      ? [{ value: "shared", label: "Shared" }]
      : []),
  ];
  return {
    id: "source",
    label: "Source",
    allLabel: "All sources",
    icon: Share2,
    info: "Where the variable comes from: written on the app itself, or a shared variable the app opted into.",
    options,
    match: (row, value) => row.kind === value,
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
 * same clear-everything button.
 *
 * ONE row on a desktop: search, then every filter dropdown, then the sort (+ the
 * page's own action). `lg:flex-nowrap` + flexible bases let the dropdowns share
 * the width and truncate their own labels; below `lg` the row wraps.
 */
export function EnvFilters<T extends FilterableVar>({
  state,
  onChange,
  onClear,
  facets,
  counts,
  actions,
  className,
  noun = "variables",
  keySortLabel = "Key (A–Z)",
}: {
  state: EnvFilterState;
  onChange: (next: EnvFilterState) => void;
  /** Reset every filter but keep the sort — {@link useEnvFilters}'s `clear`. */
  onClear: () => void;
  facets: EnvFacet<T>[];
  /** Per-option row counts — {@link facetCounts}. */
  counts?: Record<string, Record<string, number>>;
  /**
   * The table's own action (an app's "Add"), rendered LAST on the row — after
   * the sort, pinned to the toolbar's right edge.
   */
  actions?: React.ReactNode;
  className?: string;
  /** What this table lists, PLURAL — drives the search placeholder and the
   *  screen-reader labels ("Search credentials"). */
  noun?: string;
  /** How the A–Z sort names the row's identifying column ("Username (A–Z)"). */
  keySortLabel?: string;
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

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 lg:flex-nowrap",
        className,
      )}
    >
      {/* The search gets first claim on the width but yields on a crowded row —
          a desktop caps it so six dropdowns still fit beside it. */}
      <div className="relative min-w-[11rem] flex-1 basis-full sm:basis-auto lg:max-w-[16rem]">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={state.q}
          onChange={(e) => onChange({ ...state, q: e.target.value })}
          placeholder={`Search ${noun}…`}
          aria-label={`Search ${noun}`}
          className="h-9 pl-9"
        />
      </div>

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

      {/* The slot is RESERVED, never conditionally mounted: this button turns up
          on the first keystroke, and inserting it into the row would shove the
          controls around it while the cursor is still in the search box.
          `invisible` also takes it out of the tab order and the a11y tree, so an
          idle toolbar exposes nothing to clear. */}
      <Button
        variant="ghost"
        size="sm"
        disabled={!hasFilter}
        className={cn("shrink-0", !hasFilter && "invisible")}
        onClick={onClear}
      >
        Clear filters
      </Button>

      <Select
        value={state.sort}
        onValueChange={(v) => onChange({ ...state, sort: v as EnvSort })}
      >
        <SelectTrigger
          className="w-[11.5rem] shrink-0"
          aria-label={`Sort ${noun}`}
        >
          {/* `flex!` is load-bearing: SelectTrigger applies `[&>span]:line-clamp-1`
              to its direct-child spans, whose `display:-webkit-box` outranks a
              plain `flex` class (the `>span` selector is more specific) and would
              stack the icon above the value. The important modifier keeps them on
              one row. The arrows icon is what says "this is the sort" — no label. */}
          <span className="flex! items-center gap-2">
            <ArrowUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            <SelectValue />
          </span>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="recent">Recently modified</SelectItem>
          <SelectItem value="oldest">Oldest first</SelectItem>
          <SelectItem value="key">{keySortLabel}</SelectItem>
        </SelectContent>
      </Select>

      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Compact by design: six of these share one desktop row, so a permanent
 *  "Environment:" prefix would leave no room for the value. Idle, the control IS
 *  the facet's name; with one pick it becomes the pick; with several, the name
 *  plus how many. The full picture is one click away, in the menu. */
function facetSummary<T>(facet: EnvFacet<T>, values: string[]): string {
  if (facet.options.length === 0) return `${facet.label} — none`;
  if (values.length === 0) return facet.label;
  if (values.length === 1)
    return (
      facet.options.find((o) => o.value === values[0])?.label ?? facet.label
    );
  return `${facet.label} · ${values.length}`;
}

/** The hover title of an active control: every picked label, spelled out. */
function facetTitle<T>(facet: EnvFacet<T>, values: string[]): string {
  return values.length > 0
    ? `${facet.label}: ${facet.options
        .filter((o) => values.includes(o.value))
        .map((o) => o.label)
        .join(", ")}`
    : `Filter by ${facet.label.toLowerCase()}`;
}

/**
 * One facet on the toolbar. Both shapes share the multi-select menu — tick as
 * many options as you like (they are OR-ed), see how many rows each one would
 * leave, clear the whole facet from the row at the top — and differ only in the
 * control: a `searchable` facet (people lists) is a combobox whose toolbar
 * control IS an autocomplete input, everything else is a button that opens the
 * menu.
 */
function FacetPicker<T>(props: {
  facet: EnvFacet<T>;
  values: string[];
  counts?: Record<string, number>;
  onChange: (values: string[]) => void;
}) {
  const { facet } = props;
  return (
    <div className="flex min-w-[10rem] flex-1 items-center gap-1 lg:min-w-0">
      {facet.searchable ? (
        <FacetCombobox {...props} />
      ) : (
        <FacetMenu {...props} />
      )}
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

/** One option of a facet menu: checkbox, avatar for a person, label, hint, and
 *  how many rows picking it would leave. In a combobox listbox it also carries
 *  the `option` role and the keyboard highlight (`active`). */
function FacetOptionRow({
  opt,
  checked,
  count,
  onToggle,
  id,
  active,
  onActivate,
}: {
  opt: FacetOption;
  checked: boolean;
  count?: number;
  onToggle: () => void;
  /** Set by the combobox — the row becomes an aria `option` the input points at. */
  id?: string;
  active?: boolean;
  onActivate?: () => void;
}) {
  return (
    <label
      id={id}
      role={id ? "option" : undefined}
      aria-selected={id ? checked : undefined}
      onMouseEnter={onActivate}
      // Keep the combobox input focused while ticking — a row must never steal
      // the caret mid-search.
      onMouseDown={id ? (e) => e.preventDefault() : undefined}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
        active ? "bg-accent" : "hover:bg-accent",
        // Ticking it would add nothing — shown, so you can see the option
        // exists, greyed, so you know why it's pointless.
        count === 0 && !checked && "opacity-50",
      )}
    >
      <Checkbox checked={checked} onCheckedChange={onToggle} />
      {opt.author && (
        <Avatar className="size-5 shrink-0">
          <AvatarFallback
            className="text-[9px]"
            style={{
              backgroundColor: opt.author.avatarColor,
              color: "#000",
            }}
          >
            {opt.author.username.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
      )}
      <span className="truncate">{opt.label}</span>
      {opt.hint && (
        <span className="truncate text-xs text-muted-foreground">
          {opt.hint}
        </span>
      )}
      {count != null && (
        <span className="ml-auto pl-2 text-xs tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
    </label>
  );
}

/** The default facet control: a button stating the filter in its own words —
 *  "Modified by: Ada" / "Modified by · 3" — that opens the multi-select menu. */
function FacetMenu<T>({
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

  function toggle(value: string) {
    onChange(
      values.includes(value)
        ? values.filter((v) => v !== value)
        : [...values, value],
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={empty}
          aria-label={`Filter by ${facet.label.toLowerCase()}`}
          title={facetTitle(facet, values)}
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
          <span className="truncate">{facetSummary(facet, values)}</span>
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
          {facet.options.map((opt) => (
            <FacetOptionRow
              key={opt.value}
              opt={opt}
              checked={values.includes(opt.value)}
              count={counts?.[opt.value]}
              onToggle={() => toggle(opt.value)}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The `searchable` facet control: a combobox. The toolbar control IS an input —
 * type a name straight into it and the menu narrows live, no menu-then-search
 * two-step. Idle, the placeholder wears the summary ("Modified by" / "Ada" /
 * "Modified by · 3"); the value is always the needle, so what you typed and what
 * is picked never fight over the same box.
 *
 * Keyboard: ↑/↓ walk the menu (the clear row rides at index 0), Enter ticks,
 * Escape clears the needle first and closes second, Tab moves on. Focus stays in
 * the input throughout — the menu is pointed at via `aria-activedescendant`.
 */
function FacetCombobox<T>({
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
  const baseId = React.useId();
  const anchorRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [open, setOpen] = React.useState(false);
  // The autocomplete needle. Reset on close so the menu reopens whole — a stale
  // needle would read as options having vanished.
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);

  const on = values.length > 0;
  const empty = facet.options.length === 0;

  const needle = query.trim().toLowerCase();
  // Never hide a TICKED option: unticking must stay one click away even when the
  // needle no longer matches it.
  const shownOptions = needle
    ? facet.options.filter(
        (o) =>
          values.includes(o.value) ||
          `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(needle),
      )
    : facet.options;

  // Index 0 is the clear row; the options follow. Clamp instead of resetting so
  // the highlight survives the list shrinking under a longer needle.
  const rowCount = shownOptions.length + 1;
  const activeIndex = Math.min(active, rowCount - 1);
  const optionId = (index: number) => `${baseId}-opt-${index}`;

  React.useEffect(() => {
    if (!open) return;
    document
      .getElementById(optionId(activeIndex))
      ?.scrollIntoView({ block: "nearest" });
    // optionId is render-stable (useId); only the highlight moves the scroll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, activeIndex]);

  function close() {
    setOpen(false);
    setQuery("");
    setActive(0);
  }

  function toggle(value: string) {
    onChange(
      values.includes(value)
        ? values.filter((v) => v !== value)
        : [...values, value],
    );
    // A row is a <label> whose activation forwards to the checkbox button —
    // reclaim the caret so the next keystroke keeps narrowing.
    inputRef.current?.focus();
  }

  /** Enter / click on row `index`: the clear row clears, an option toggles. The
   *  menu STAYS open — this is a multi-select, one pick is rarely the last. */
  function pick(index: number) {
    if (index === 0) {
      onChange([]);
      inputRef.current?.focus();
      return;
    }
    const opt = shownOptions[index - 1];
    if (opt) toggle(opt.value);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive(
        e.key === "ArrowDown"
          ? Math.min(activeIndex + 1, rowCount - 1)
          : Math.max(activeIndex - 1, 0),
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open) pick(activeIndex);
      else setOpen(true);
    } else if (e.key === "Tab") {
      // Let the Tab through — just don't leave a menu floating behind it.
      close();
    }
  }

  return (
    <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
      <PopoverAnchor asChild>
        <div ref={anchorRef} className="relative min-w-0 flex-1">
          {Icon && (
            <Icon
              className={cn(
                "pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2",
                on ? "text-foreground" : "text-muted-foreground",
              )}
            />
          )}
          <Input
            ref={inputRef}
            role="combobox"
            aria-expanded={open}
            aria-controls={`${baseId}-listbox`}
            aria-autocomplete="list"
            aria-activedescendant={open ? optionId(activeIndex) : undefined}
            aria-label={`Filter by ${facet.label.toLowerCase()}`}
            title={facetTitle(facet, values)}
            disabled={empty}
            value={query}
            placeholder={facetSummary(facet, values)}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onClick={() => setOpen(true)}
            onKeyDown={onKeyDown}
            className={cn(
              "h-9 pr-8",
              Icon ? "pl-8" : "pl-3",
              // An active filter wears the same tint as an active FacetMenu
              // button, and its summary-as-placeholder reads as a VALUE, not a
              // hint — it is what the filter is doing right now.
              on &&
                "border-primary/60 bg-primary/[0.06] placeholder:text-foreground",
            )}
          />
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 opacity-50" />
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="min-w-64 p-1"
        style={{ width: "var(--radix-popper-anchor-width)" }}
        // Focus lives in the input for the combobox's whole life: never yank it
        // into the menu on open, never fling it elsewhere on close, and don't
        // treat clicks on the input (the ANCHOR — outside the content) as a
        // dismissal.
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onInteractOutside={(e) => {
          if (anchorRef.current?.contains(e.target as Node)) e.preventDefault();
        }}
        // Escape backs out one layer at a time: a needle is cleared, an empty
        // box is closed.
        onEscapeKeyDown={(e) => {
          if (query) {
            e.preventDefault();
            setQuery("");
            setActive(0);
          }
        }}
      >
        <div id={`${baseId}-listbox`} role="listbox" aria-multiselectable="true">
          <button
            type="button"
            id={optionId(0)}
            role="option"
            aria-selected={!on}
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => setActive(0)}
            onClick={() => pick(0)}
            className={cn(
              "flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm",
              activeIndex === 0 ? "bg-accent" : "hover:bg-accent",
              !on && "font-medium",
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center">
              {!on && <Check className="size-3.5" />}
            </span>
            {facet.allLabel}
          </button>
          <div aria-hidden className="my-1 h-px bg-border" />
          <div className="max-h-72 space-y-0.5 overflow-y-auto">
            {shownOptions.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">
                No match for “{query.trim()}”.
              </p>
            )}
            {shownOptions.map((opt, i) => (
              <FacetOptionRow
                key={opt.value}
                opt={opt}
                checked={values.includes(opt.value)}
                count={counts?.[opt.value]}
                onToggle={() => toggle(opt.value)}
                id={optionId(i + 1)}
                active={activeIndex === i + 1}
                onActivate={() => setActive(i + 1)}
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
