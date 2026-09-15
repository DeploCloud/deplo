import type * as React from "react";
import type { DocsTopic } from "@/lib/docs";
import type { VarAuthor } from "@/lib/types/identity";

export const FACET_NONE = "__none__";

export type EnvSort = "recent" | "oldest" | "key";

export interface EnvFilterState {
  q: string;
  sort: EnvSort;
  facets: Record<string, string[]>;
}

export const EMPTY_ENV_FILTERS: EnvFilterState = {
  q: "",
  sort: "recent",
  facets: {},
};

export interface FilterableVar {
  key: string;
  updatedAt: string;
  createdBy?: VarAuthor | null;
  updatedBy?: VarAuthor | null;
}

export interface TypedVar extends FilterableVar {
  type: "plain" | "secret";
}

export interface FacetOption {
  value: string;
  label: string;
  hint?: string;
  author?: VarAuthor;
  leading?: React.ReactNode;
  group?: string;
  labelClassName?: string;
}

export interface EnvFacet<T> {
  id: string;
  label: string;
  allLabel: string;
  info?: React.ReactNode;
  docs?: DocsTopic;
  icon?: React.ComponentType<{ className?: string }>;
  options: FacetOption[];
  match: (row: T, value: string) => boolean;
  persistent?: boolean;
  searchable?: boolean;
}

export interface SourceRow {
  kind: "standalone" | "shared";
}
