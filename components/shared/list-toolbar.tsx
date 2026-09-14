"use client";

import * as React from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ViewToggle, type ListView } from "@/components/shared/view-toggle";

export type { ListView };

// ListToolbar is the one search / filter / view / create row every list wears.
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
  view?: ListView;
  onView?: (v: ListView) => void;
  gridLabel?: string;
  listLabel?: string;
  filters?: React.ReactNode;
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
