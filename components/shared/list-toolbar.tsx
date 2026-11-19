"use client";

import type * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  ViewChoice,
  ViewToggle,
  type ListView,
} from "@/components/shared/view-toggle";
import { FilterSheet } from "@/components/shared/filter-sheet";
import {
  FacetSection,
  FiltersPopover,
} from "@/components/env/env-filters/filters-popover";
import type { FacetOption } from "@/components/env/env-filters/types";
import { cn } from "@/lib/utils";

export type { ListView };

export interface ToolbarFacet {
  id: string;
  label: string;
  icon?: React.ComponentType<{ className?: string }>;
  options: FacetOption[];
  values: string[];
  counts?: Record<string, number>;
  onChange: (values: string[]) => void;
  searchable?: boolean;
  // Shown even with fewer than two options.
  persistent?: boolean;
}

// Search, every filter behind one Filters button, then sort, view and the list's actions.
export function ListToolbar({
  query,
  onQuery,
  placeholder,
  facets = [],
  onClear,
  sort,
  view,
  onView,
  gridLabel = "Grid view",
  listLabel = "List view",
  action,
  className,
}: {
  query: string;
  onQuery: (v: string) => void;
  placeholder: string;
  facets?: ToolbarFacet[];
  // Clears every facet at once, for a caller whose facets share one state.
  onClear?: () => void;
  sort?: React.ReactNode;
  view?: ListView;
  onView?: (v: ListView) => void;
  gridLabel?: string;
  listLabel?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  const shown = facets.filter(
    (f) => f.options.length >= 2 || f.persistent || f.values.length > 0,
  );
  const active = shown.filter((f) => f.values.length > 0).length;
  const clear =
    onClear ??
    (() => {
      for (const f of shown) if (f.values.length > 0) f.onChange([]);
    });
  const hasFacets = shown.length > 0;
  const hasView = Boolean(view && onView);
  // Below md the filters, the sort and the grid/list choice all move into one sheet.
  const sheet = hasFacets || hasView;

  const sections = hasFacets && (
    <div className="divide-y divide-border">
      {shown.map((f) => (
        <FacetSection
          key={f.id}
          facet={f}
          values={f.values}
          counts={
            f.counts &&
            Object.fromEntries(
              f.options.map((o) => [o.value, f.counts?.[o.value] ?? 0]),
            )
          }
          onChange={f.onChange}
        />
      ))}
    </div>
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 lg:flex-nowrap",
        className,
      )}
    >
      <div className="flex w-full gap-2 md:contents">
        <div className="relative min-w-[11rem] flex-1 basis-full sm:basis-auto">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="h-9 pl-9"
          />
        </div>
        {sheet && (
          <FilterSheet
            active={active}
            onClear={hasFacets ? clear : undefined}
            label={hasFacets ? "Filters" : "View"}
          >
            {sections}
            {sort}
            {view && onView && (
              <ViewChoice
                view={view}
                onView={onView}
                gridLabel={gridLabel}
                listLabel={listLabel}
              />
            )}
          </FilterSheet>
        )}
      </div>

      <div className={cn("contents", sheet && "max-md:hidden")}>
        {hasFacets && (
          <FiltersPopover active={active} onClear={clear}>
            {sections}
          </FiltersPopover>
        )}
        {sort}
        {view && onView && (
          <ViewToggle
            view={view}
            onView={onView}
            gridLabel={gridLabel}
            listLabel={listLabel}
          />
        )}
      </div>

      {action && (
        <div className="flex shrink-0 items-center gap-2">{action}</div>
      )}
    </div>
  );
}
