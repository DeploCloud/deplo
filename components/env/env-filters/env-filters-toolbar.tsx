"use client";

import type * as React from "react";
import { ArrowUpDown, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { FilterSheet } from "@/components/shared/filter-sheet";
import { activeFacets, FacetSections, FiltersPopover } from "./filters-popover";
import type { EnvFacet, EnvFilterState, EnvSort, FilterableVar } from "./types";

export function EnvFilters<T extends FilterableVar>({
  state,
  onChange,
  facets,
  counts,
  actions,
  className,
  noun = "variables",
  keySortLabel = "Key (A-Z)",
}: {
  state: EnvFilterState;
  onChange: (next: EnvFilterState) => void;
  facets: EnvFacet<T>[];
  counts?: Record<string, Record<string, number>>;
  actions?: React.ReactNode;
  className?: string;
  noun?: string;
  keySortLabel?: string;
}) {
  const picked = activeFacets(state);

  const visible = facets.filter(
    (f) =>
      f.options.length >= 2 ||
      f.persistent ||
      Boolean(state.facets[f.id]?.length),
  );

  const sections = (
    <FacetSections
      facets={visible}
      state={state}
      counts={counts}
      onChange={onChange}
    />
  );
  const clearFacets = () => onChange({ ...state, facets: {} });
  const sortSelect = (
    <Select
      value={state.sort}
      onValueChange={(v) => onChange({ ...state, sort: v as EnvSort })}
    >
      <SelectTrigger
        className="w-[11.5rem] shrink-0"
        aria-label={`Sort ${noun}`}
      >
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
  );
  // Facets plus the sort make two or more controls: below md they move into a sheet.
  const sheet = visible.length > 0;

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
            value={state.q}
            onChange={(e) => onChange({ ...state, q: e.target.value })}
            placeholder={`Search ${noun}`}
            aria-label={`Search ${noun}`}
            className="h-9 pl-9"
          />
        </div>
        {sheet && (
          <FilterSheet active={picked} onClear={clearFacets}>
            {sections}
            {sortSelect}
          </FilterSheet>
        )}
      </div>

      <div className={cn("contents", sheet && "max-md:hidden")}>
        {sheet && (
          <FiltersPopover active={picked} onClear={clearFacets}>
            {sections}
          </FiltersPopover>
        )}
        {sortSelect}
      </div>

      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
