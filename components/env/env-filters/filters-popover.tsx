"use client";

import * as React from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { FacetOptionList, toggleValue } from "./facet-options";
import type { EnvFacet, FacetOption } from "./types";

// Past this many people a facet gets its own search box.
const SEARCH_FROM = 7;

function matches(opt: FacetOption, q: string): boolean {
  return `${opt.label} ${opt.hint ?? ""}`.toLowerCase().includes(q);
}

// What a section reads of a facet: an env facet and a toolbar facet both fit.
export type SectionFacet = Pick<
  EnvFacet<never>,
  "label" | "icon" | "options" | "searchable"
>;

export function FacetSection({
  facet,
  values,
  counts,
  onChange,
}: {
  facet: SectionFacet;
  values: string[];
  counts?: Record<string, number>;
  onChange: (values: string[]) => void;
}) {
  const [q, setQ] = React.useState("");
  const people = facet.options.some((o) => o.author);
  const searchable = facet.searchable && facet.options.length >= SEARCH_FROM;
  const needle = q.trim().toLowerCase();
  const shown = needle
    ? facet.options.filter((o) => matches(o, needle))
    : facet.options;
  // What is already picked stays in reach while the rest scrolls.
  const ordered = [
    ...shown.filter((o) => values.includes(o.value)),
    ...shown.filter((o) => !values.includes(o.value)),
  ];
  const Icon = facet.icon;
  const noun = people ? "people" : `${facet.label.toLowerCase()}s`;
  return (
    <div className="px-1 pt-1 pb-2">
      <p className="flex items-center gap-2 px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
        {Icon && <Icon className="size-3.5" />}
        {facet.label}
      </p>
      {searchable && (
        <div className="relative px-1 pb-1">
          <Search className="pointer-events-none absolute top-1/2 left-3.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={`Search ${facet.options.length} ${noun}`}
            aria-label={`Search ${facet.label.toLowerCase()}`}
            className="h-8 pl-8 text-sm"
          />
        </div>
      )}
      <FacetOptionList
        options={ordered}
        values={values}
        counts={counts}
        onChange={onChange}
        onToggle={(value) => onChange(toggleValue(values, value))}
        className={people ? "max-h-[8.5rem]" : undefined}
        empty={
          ordered.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {people ? "No one matches." : "Nothing matches."}
            </p>
          )
        }
      />
    </div>
  );
}

// Every facet behind one button, the count of those in use on it.
export function FiltersPopover({
  active,
  onClear,
  children,
}: {
  active: number;
  onClear: () => void;
  children: React.ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className="shrink-0 data-[state=open]:bg-accent"
        >
          <SlidersHorizontal />
          Filters
          {active > 0 && (
            <span className="grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1.5 text-xs text-primary-foreground tabular-nums">
              {active}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="max-h-[min(36rem,var(--radix-popover-content-available-height))] w-80 overflow-y-auto p-0"
      >
        {children}
        <div className="flex justify-end border-t border-border p-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={active === 0}
            onClick={onClear}
          >
            Clear all
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
