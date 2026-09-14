"use client";

import * as React from "react";
import { applyEnvFilters, facetCounts } from "./filtering";
import { EMPTY_ENV_FILTERS } from "./types";
import type { EnvFacet, EnvFilterState, FilterableVar } from "./types";

// useEnvFilters owns one table's filter state, the rows that survive it and the
// per-option counts; `clear` keeps the SORT, an ordering is not a filter.
export function useEnvFilters<T extends FilterableVar>(
  rows: T[],
  facets: EnvFacet<T>[],
  extraHaystack?: (row: T) => string,
) {
  const [state, setState] = React.useState<EnvFilterState>(EMPTY_ENV_FILTERS);

  const shown = React.useMemo(
    () => applyEnvFilters(rows, state, facets, extraHaystack),
    // `extraHaystack` is a per-render arrow at every call site; depending on it
    // would recompute on every render and pin nothing down. The rows it reads
    // are in `rows`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, state, facets],
  );
  const counts = React.useMemo(
    () => facetCounts(rows, state, facets, extraHaystack),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, state, facets],
  );

  const clear = React.useCallback(
    () => setState((s) => ({ ...EMPTY_ENV_FILTERS, sort: s.sort })),
    [],
  );

  return { state, setState, clear, shown, counts };
}
