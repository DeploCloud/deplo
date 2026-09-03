"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ViewToggle, type ListView } from "@/components/shared/view-toggle";

export type { ListView };

/**
 * The one search / filter / view / create row every list wears: search on the
 * left, then the filters, then the view toggle, and the create button last.
 */
export function ListToolbar({
  query,
  onQuery,
  placeholder,
  view,
  onView,
  gridLabel = "Grid view",
  listLabel = "List view",
  filters,
  action,
}: {
  query: string;
  onQuery: (v: string) => void;
  placeholder: string;
  /** Omit both to render no view toggle. */
  view?: ListView;
  onView?: (v: ListView) => void;
  /** What the two toggle buttons are called - a real table says "Table view". */
  gridLabel?: string;
  listLabel?: string;
  /** The `Select`s for this list, rendered between the search and the toggle. */
  filters?: React.ReactNode;
  /** The create button. Always last, so it sits in the same place on every list. */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="pl-9"
        />
      </div>
      {filters}
      {view && onView && (
        <ViewToggle
          view={view}
          onView={onView}
          gridLabel={gridLabel}
          listLabel={listLabel}
        />
      )}
      {action}
    </div>
  );
}
