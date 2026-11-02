"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  ViewChoice,
  ViewToggle,
  type ListView,
} from "@/components/shared/view-toggle";
import { FilterSheet } from "@/components/shared/filter-sheet";

export type { ListView };

export function ListToolbar({
  query,
  onQuery,
  placeholder,
  view,
  onView,
  gridLabel = "Grid view",
  listLabel = "List view",
  filters,
  filterSheet,
  action,
}: {
  query: string;
  onQuery: (v: string) => void;
  placeholder: string;
  view?: ListView;
  onView?: (v: ListView) => void;
  gridLabel?: string;
  listLabel?: string;
  filters?: React.ReactNode;
  // Set when there is more than one filter: the sheet then counts them and offers Clear all.
  filterSheet?: { active: number; onClear: () => void };
  action?: React.ReactNode;
}) {
  const hasView = Boolean(view && onView);
  // Below md the filters and the grid/list choice both live in the sheet, never in the page.
  const sheet = Boolean(filterSheet) || hasView;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="flex flex-1 gap-2">
        <div className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => onQuery(e.target.value)}
            placeholder={placeholder}
            aria-label={placeholder}
            className="pl-9"
          />
        </div>
        {sheet && (
          <FilterSheet
            active={filterSheet?.active ?? 0}
            onClear={filterSheet?.onClear}
            label={filters ? "Filters" : "View"}
          >
            {filters}
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
      {sheet ? (
        <div className="contents max-md:hidden">{filters}</div>
      ) : (
        filters
      )}
      {view && onView && (
        <ViewToggle
          view={view}
          onView={onView}
          gridLabel={gridLabel}
          listLabel={listLabel}
          className="max-md:hidden"
        />
      )}
      {action}
    </div>
  );
}
