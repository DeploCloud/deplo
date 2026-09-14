import type { EnvFacet } from "./types";

// facetSummary is compact by design: six controls share one desktop row, so a
// permanent "Environment:" prefix would leave no room for the value.
export function facetSummary<T>(facet: EnvFacet<T>, values: string[]): string {
  if (facet.options.length === 0) return `${facet.label}, none`;
  if (values.length === 0) return facet.label;
  if (values.length === 1)
    return (
      facet.options.find((o) => o.value === values[0])?.label ?? facet.label
    );
  return `${facet.label} · ${values.length}`;
}

// facetTitle is the hover title of an active control: every picked label, spelled out.
export function facetTitle<T>(facet: EnvFacet<T>, values: string[]): string {
  return values.length > 0
    ? `${facet.label}: ${facet.options
        .filter((o) => values.includes(o.value))
        .map((o) => o.label)
        .join(", ")}`
    : `Filter by ${facet.label.toLowerCase()}`;
}
