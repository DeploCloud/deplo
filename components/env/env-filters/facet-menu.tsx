"use client";

import { ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { FacetClearRow, FacetOptionList, toggleValue } from "./facet-options";
import { facetSummary, facetTitle } from "./facet-summary";
import type { EnvFacet } from "./types";

export function FacetMenu<T>({
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

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={empty}
          aria-label={`Filter by ${facet.label.toLowerCase()}`}
          title={facetTitle(facet, values)}
          className={cn(
            "flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-full border border-transparent bg-field px-3 text-sm transition-colors max-md:h-11 max-md:text-[15px]",
            "focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background focus:outline-none",
            "disabled:cursor-not-allowed disabled:opacity-50",
            on
              ? "border-primary/60 bg-primary-wash text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {Icon && <Icon className="size-3.5 shrink-0" />}
          <span className="truncate">{facetSummary(facet, values)}</span>
          <ChevronDown className="ml-auto size-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-1.5">
        <FacetClearRow
          label={facet.allLabel}
          on={on}
          onSelect={() => onChange([])}
        />
        <div className="-mx-1.5 my-1.5 h-px bg-border" />
        <FacetOptionList
          options={facet.options}
          values={values}
          counts={counts}
          onChange={onChange}
          onToggle={(value) => onChange(toggleValue(values, value))}
        />
      </PopoverContent>
    </Popover>
  );
}
