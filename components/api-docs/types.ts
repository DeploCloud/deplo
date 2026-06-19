import type { Capability } from "@/lib/types";

/**
 * Client-safe mirror of the API catalog shapes from `lib/graphql/introspect.ts`.
 * That module is `server-only` (it walks the executable schema), so the docs
 * page builds the catalog on the server and hands these plain objects to the
 * client components. Keep these in sync with the server types.
 */

export type FieldScope =
  | { kind: "public" }
  | { kind: "loggedIn" }
  | { kind: "capability"; capability: Capability }
  | { kind: "instanceAdmin" };

export interface ApiArgDoc {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
}

export interface ApiFieldDoc {
  name: string;
  operation: "query" | "mutation";
  description: string | null;
  returnType: string;
  args: ApiArgDoc[];
  scope: FieldScope;
  group: string;
}

export interface ApiCatalog {
  queries: ApiFieldDoc[];
  mutations: ApiFieldDoc[];
  sdl: string;
  /** The `__schema` introspection JSON — rebuilt client-side for the editor. */
  introspection: unknown;
}

/** The simulated outcome of one dry-run mutation field (mirrors playground.ts). */
export interface DryRunField {
  field: string;
  allowed: boolean;
  message: string;
  requires: Capability | null;
}

/** The playground endpoint's response, discriminated by `kind`. */
export type PlaygroundResult =
  | { kind: "query"; data: unknown; errors: { message: string }[] | null }
  | { kind: "dry-run"; fields: DryRunField[] }
  | { kind: "error"; errors: { message: string }[] };
