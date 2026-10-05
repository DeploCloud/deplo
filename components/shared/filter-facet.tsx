"use client";

import * as React from "react";

import { FacetCombobox } from "@/components/env/env-filters/facet-combobox";
import type { EnvFacet, FacetOption } from "@/components/env/env-filters/types";
import { useSearchParams } from "@/lib/nav";
import { cn } from "@/lib/utils";

const MATCH_ALL = () => true;

// A searchable multi-select facet whose rows the caller filters itself.
export function listFacet(
  id: string,
  label: string,
  allLabel: string,
  icon: EnvFacet<never>["icon"],
  options: FacetOption[],
): EnvFacet<never> {
  return {
    id,
    label,
    allLabel,
    icon,
    options,
    match: MATCH_ALL,
    persistent: true,
    searchable: true,
  };
}

export function FilterFacet({
  id,
  label,
  allLabel,
  icon,
  options,
  values,
  counts,
  onChange,
  className,
}: {
  id: string;
  label: string;
  allLabel: string;
  icon: EnvFacet<never>["icon"];
  options: FacetOption[];
  values: string[];
  counts?: Record<string, number>;
  onChange: (values: string[]) => void;
  className?: string;
}) {
  const facet = React.useMemo(
    () => listFacet(id, label, allLabel, icon, options),
    [id, label, allLabel, icon, options],
  );
  return (
    <div className={cn("flex min-w-0 sm:w-40", className)}>
      <FacetCombobox
        facet={facet}
        values={values}
        counts={counts}
        onChange={onChange}
      />
    </div>
  );
}

// Filters kept in the address (?team=a,b), so a shared link opens already narrowed.
export function useUrlFacets<K extends string>(
  keys: readonly K[],
): [Record<K, string[]>, (key: K, values: string[]) => void] {
  const params = useSearchParams();
  const values = Object.fromEntries(
    keys.map((k) => [k, (params.get(k) ?? "").split(",").filter(Boolean)]),
  ) as Record<K, string[]>;
  function set(key: K, next: string[]) {
    const p = new URLSearchParams(window.location.search);
    if (next.length > 0) p.set(key, next.join(","));
    else p.delete(key);
    const s = p.toString().replace(/%2C/g, ",");
    window.history.replaceState(
      null,
      "",
      s ? `?${s}` : window.location.pathname,
    );
  }
  return [values, set];
}
