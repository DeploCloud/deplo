import type { EnvFacet, EnvFilterState, FilterableVar } from "./types";

// timestamp reads an ISO date as millis, treating an unparsable one as the epoch.
export function timestamp(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function matchesFilters<T extends FilterableVar>(
  row: T,
  f: EnvFilterState,
  facets: EnvFacet<T>[],
  extraHaystack?: (row: T) => string,
  // Ignore this facet - how a facet counts its OWN options (see facetCounts).
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
    // OR within one facet: picking Ada AND Linus means "either of them", not
    // "both of them", no row could ever satisfy the latter.
    if (!values.some((value) => facet.match(row, value))) return false;
  }
  return true;
}

// applyEnvFilters narrows + sorts a page of variables.
export function applyEnvFilters<T extends FilterableVar>(
  rows: T[],
  f: EnvFilterState,
  facets: EnvFacet<T>[] = [],
  extraHaystack?: (row: T) => string,
): T[] {
  // `filter` already returns a fresh array, so the sort below never mutates the
  // caller's rows.
  const out = rows.filter((row) =>
    matchesFilters(row, f, facets, extraHaystack),
  );

  // A bulk write (.env import / editor save) stamps every row with the SAME
  // `updatedAt` - break the tie on the key to keep the table stable.
  out.sort((a, b) => {
    if (f.sort === "key") return a.key.localeCompare(b.key);
    const delta = timestamp(b.updatedAt) - timestamp(a.updatedAt);
    if (delta !== 0) return f.sort === "oldest" ? -delta : delta;
    return a.key.localeCompare(b.key);
  });
  return out;
}

// facetCounts says how many rows each option would leave standing.
export function facetCounts<T extends FilterableVar>(
  rows: T[],
  f: EnvFilterState,
  facets: EnvFacet<T>[],
  extraHaystack?: (row: T) => string,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const facet of facets) {
    // Seeded at 0 so an option nothing matches still reports a count - that zero
    // is what greys it out in the menu instead of leaving it mute.
    const counts: Record<string, number> = {};
    for (const opt of facet.options) counts[opt.value] = 0;
    for (const row of rows) {
      if (!matchesFilters(row, f, facets, extraHaystack, facet.id)) continue;
      // A row may satisfy SEVERAL options of one facet (shared both team-wide
      // and with an app) - it counts under each.
      for (const opt of facet.options) {
        if (facet.match(row, opt.value)) counts[opt.value] += 1;
      }
    }
    out[facet.id] = counts;
  }
  return out;
}
