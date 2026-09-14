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

// FacetMenu is the default facet control: a button stating the filter in its own
// words - "Modified by: Ada" / "Modified by · 3" - that opens the multi-select menu.
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
            "flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md border border-input bg-background px-3 text-sm shadow-sm transition-colors",
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
      <PopoverContent align="start" className="w-64 p-1">
        <FacetClearRow
          label={facet.allLabel}
          on={on}
          onSelect={() => onChange([])}
        />
        <div className="my-1 h-px bg-border" />
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
