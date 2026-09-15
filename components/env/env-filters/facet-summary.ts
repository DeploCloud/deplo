import type { EnvFacet } from "./types";

export function facetSummary<T>(facet: EnvFacet<T>, values: string[]): string {
  if (facet.options.length === 0) return `${facet.label}, none`;
  if (values.length === 0) return facet.label;
  if (values.length === 1)
    return (
      facet.options.find((o) => o.value === values[0])?.label ?? facet.label
    );
  return `${facet.label} · ${values.length}`;
}

export function facetTitle<T>(facet: EnvFacet<T>, values: string[]): string {
  return values.length > 0
    ? `${facet.label}: ${facet.options
        .filter((o) => values.includes(o.value))
        .map((o) => o.label)
        .join(", ")}`
    : `Filter by ${facet.label.toLowerCase()}`;
}
