"use client";

import type * as React from "react";
import { ArrowUpDown, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { InfoTip } from "@/components/ui/info-tip";
import { cn } from "@/lib/utils";
import { FacetCombobox } from "./facet-combobox";
import { FacetMenu } from "./facet-menu";
import type { EnvFacet, EnvFilterState, EnvSort, FilterableVar } from "./types";

export function EnvFilters<T extends FilterableVar>({
  state,
  onChange,
  onClear,
  facets,
  counts,
  actions,
  className,
  noun = "variables",
  keySortLabel = "Key (A-Z)",
}: {
  state: EnvFilterState;
  onChange: (next: EnvFilterState) => void;
  onClear: () => void;
  facets: EnvFacet<T>[];
  counts?: Record<string, Record<string, number>>;
  actions?: React.ReactNode;
  className?: string;
  noun?: string;
  keySortLabel?: string;
}) {
  const picked = Object.values(state.facets).filter((v) => v?.length).length;
  const hasFilter = Boolean(state.q.trim()) || picked > 0;

  const visible = facets.filter(
    (f) =>
      f.options.length >= 2 ||
      f.persistent ||
      Boolean(state.facets[f.id]?.length),
  );

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-2 lg:flex-nowrap",
        className,
      )}
    >
      <div className="relative min-w-[11rem] flex-1 basis-full sm:basis-auto lg:max-w-[16rem]">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={state.q}
          onChange={(e) => onChange({ ...state, q: e.target.value })}
          placeholder={`Search ${noun}`}
          aria-label={`Search ${noun}`}
          className="h-9 pl-9"
        />
      </div>

      {visible.map((facet) => (
        <FacetPicker
          key={facet.id}
          facet={facet}
          values={state.facets[facet.id] ?? []}
          counts={counts?.[facet.id]}
          onChange={(values) =>
            onChange({
              ...state,
              facets: { ...state.facets, [facet.id]: values },
            })
          }
        />
      ))}

      <Button
        variant="ghost"
        disabled={!hasFilter}
        className={cn("shrink-0", !hasFilter && "invisible")}
        onClick={onClear}
      >
        Clear filters
      </Button>

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

      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

function FacetPicker<T>(props: {
  facet: EnvFacet<T>;
  values: string[];
  counts?: Record<string, number>;
  onChange: (values: string[]) => void;
}) {
  const { facet } = props;
  return (
    <div className="flex min-w-[10rem] flex-1 items-center gap-1 lg:min-w-0">
      {facet.searchable ? (
        <FacetCombobox {...props} />
      ) : (
        <FacetMenu {...props} />
      )}
      {facet.info != null && (
        <InfoTip
          content={facet.info}
          docs={facet.docs}
          className="shrink-0"
          label={`About the ${facet.label.toLowerCase()} filter`}
        />
      )}
    </div>
  );
}
