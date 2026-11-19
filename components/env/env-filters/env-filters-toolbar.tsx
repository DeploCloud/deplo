"use client";

import type * as React from "react";
import { ArrowUpDown } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ListToolbar } from "@/components/shared/list-toolbar";
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
  return (
    <ListToolbar
      query={state.q}
      onQuery={(q) => onChange({ ...state, q })}
      placeholder={`Search ${noun}`}
      facets={facets.map((f) => ({
        ...f,
        values: state.facets[f.id] ?? [],
        counts: counts?.[f.id],
        onChange: (values) =>
          onChange({ ...state, facets: { ...state.facets, [f.id]: values } }),
      }))}
      onClear={() => onChange({ ...state, facets: {} })}
      sort={
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
      }
      action={actions}
      className={className}
    />
  );
}
