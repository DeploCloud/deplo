import type * as React from "react";
import type { DocsTopic } from "@/lib/docs";
import type { VarAuthor } from "@/lib/types/identity";

// FACET_NONE is the option value for "this row has no such thing" (no project, no author…).
export const FACET_NONE = "__none__";

// EnvSort sorts over the "Last modified" column, plus an A→Z escape hatch by key.
export type EnvSort = "recent" | "oldest" | "key";

export interface EnvFilterState {
  q: string;
  sort: EnvSort;
  // facet id → the values picked in it: OR-ed inside one facet, AND-ed between facets.
  facets: Record<string, string[]>;
}

// EMPTY_ENV_FILTERS is the reset state - recently-modified first.
export const EMPTY_ENV_FILTERS: EnvFilterState = {
  q: "",
  sort: "recent",
  facets: {},
};

// FilterableVar is the row shape every facet can count on.
export interface FilterableVar {
  key: string;
  updatedAt: string;
  createdBy?: VarAuthor | null;
  updatedBy?: VarAuthor | null;
}

// TypedVar is a FilterableVar that is plain-or-secret - what typeFacet needs.
export interface TypedVar extends FilterableVar {
  type: "plain" | "secret";
}

// FacetOption is one choice inside a facet.
export interface FacetOption {
  value: string;
  label: string;
  // Disambiguates repeated labels - "Production" exists in every project.
  hint?: string;
  author?: VarAuthor;
  // The option's own picture when it is not a person's face - an app's logo.
  leading?: React.ReactNode;
  // Heading this option sits under; unset means one flat list.
  group?: string;
  // Set where the option's own colour IS information - a log level reads as its severity.
  labelClassName?: string;
}

// EnvFacet is one filter dropdown: what it's called, what you may pick, and what picking it means.
export interface EnvFacet<T> {
  id: string;
  // The trigger's prefix, e.g. "Environment" → reads "Environment: Production".
  label: string;
  // The "off" row at the top of the menu, e.g. "All environments".
  allLabel: string;
  info?: React.ReactNode;
  docs?: DocsTopic;
  icon?: React.ComponentType<{ className?: string }>;
  options: FacetOption[];
  match: (row: T, value: string) => boolean;
  // Show it even with a single option - a filter a team EXPECTS to find must not vanish.
  persistent?: boolean;
  // Render the facet as an autocomplete: the control IS an input and the menu narrows live.
  searchable?: boolean;
}

// SourceRow is a row that is either the app's own variable or a shared one it opted into.
export interface SourceRow {
  kind: "standalone" | "shared";
}
