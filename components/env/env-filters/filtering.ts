import type { EnvFacet, EnvFilterState, FilterableVar } from "./types";

export function timestamp(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function matchesFilters<T extends FilterableVar>(
  row: T,
  f: EnvFilterState,
  facets: EnvFacet<T>[],
  extraHaystack?: (row: T) => string,
  skipFacetId?: string,
): boolean {
  const q = f.q.trim().toLowerCase();
  if (q) {
    const extra = extraHaystack?.(row) ?? "";
    if (!`${row.key} ${extra}`.toLowerCase().includes(q)) return false;
  }
  for (const facet of facets) {
    if (facet.id === skipFacetId) continue;
    const values = f.facets[facet.id];
    if (!values?.length) continue;
    if (!values.some((value) => facet.match(row, value))) return false;
  }
  return true;
}

export function applyEnvFilters<T extends FilterableVar>(
  rows: T[],
  f: EnvFilterState,
  facets: EnvFacet<T>[] = [],
  extraHaystack?: (row: T) => string,
): T[] {
  const out = rows.filter((row) =>
    matchesFilters(row, f, facets, extraHaystack),
  );

  out.sort((a, b) => {
    if (f.sort === "key") return a.key.localeCompare(b.key);
    const delta = timestamp(b.updatedAt) - timestamp(a.updatedAt);
    if (delta !== 0) return f.sort === "oldest" ? -delta : delta;
    return a.key.localeCompare(b.key);
  });
  return out;
}

export function facetCounts<T extends FilterableVar>(
  rows: T[],
  f: EnvFilterState,
  facets: EnvFacet<T>[],
  extraHaystack?: (row: T) => string,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const facet of facets) {
    const counts: Record<string, number> = {};
    for (const opt of facet.options) counts[opt.value] = 0;
    for (const row of rows) {
      if (!matchesFilters(row, f, facets, extraHaystack, facet.id)) continue;
      for (const opt of facet.options) {
        if (facet.match(row, opt.value)) counts[opt.value] += 1;
      }
    }
    out[facet.id] = counts;
  }
  return out;
}
