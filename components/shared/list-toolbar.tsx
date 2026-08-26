"use client";

import * as React from "react";
import { LayoutGrid, List, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";

export type ListView = "grid" | "list";

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
        <div className="flex items-center gap-1 rounded-lg border border-border p-0.5">
          <SimpleTooltip content={gridLabel}>
            <Button
              variant={view === "grid" ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => onView("grid")}
              aria-label={gridLabel}
              aria-pressed={view === "grid"}
            >
              <LayoutGrid className="size-4" />
            </Button>
          </SimpleTooltip>
          <SimpleTooltip content={listLabel}>
            <Button
              variant={view === "list" ? "secondary" : "ghost"}
              size="icon-sm"
              onClick={() => onView("list")}
              aria-label={listLabel}
              aria-pressed={view === "list"}
            >
              <List className="size-4" />
            </Button>
          </SimpleTooltip>
        </div>
      )}
      {action}
    </div>
  );
}
