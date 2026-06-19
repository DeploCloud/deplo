import "server-only";

import {
  type GraphQLField,
  type GraphQLArgument,
  GraphQLObjectType,
  isObjectType,
  parse,
  printSchema,
  getIntrospectionQuery,
  executeSync,
} from "graphql";
import { schema } from "./schema";
import type { Capability } from "@/lib/types";

/**
 * The authorization a field requires, lifted out of the Pothos field config so
 * the API-docs page and the playground gate can read it WITHOUT re-implementing
 * the scope rules. Mirrors the three `AuthScopes` in `builder.ts`:
 *  - public        no scope — anyone (e.g. `me`, which returns null when anon)
 *  - loggedIn      any authenticated principal (cookie session or API token)
 *  - capability    holds the named capability in the active team
 *  - instanceAdmin a global instance admin
 *
 * Pothos keeps the field options (including `authScopes`) on the executable
 * field's `extensions.pothosOptions`. Every scope in this schema is a static
 * object (see the probe in the design notes — zero function-valued scopes), so
 * we can read it synchronously and turn it into this typed, serialisable shape.
 */
export type FieldScope =
  | { kind: "public" }
  | { kind: "loggedIn" }
  | { kind: "capability"; capability: Capability }
  | { kind: "instanceAdmin" };

/** One query or mutation field, flattened for rendering and gating. */
export interface ApiFieldDoc {
  /** Field name, e.g. `restartServer`. */
  name: string;
  /** `query` (read-only, safe to run) or `mutation` (dry-run only). */
  operation: "query" | "mutation";
  description: string | null;
  /** Rendered GraphQL type of the result, e.g. `[Server!]!`. */
  returnType: string;
  args: ApiArgDoc[];
  /** What the caller must hold to actually run this in production. */
  scope: FieldScope;
  /**
   * Domain bucket the field is grouped under in the docs (e.g. `server`,
   * `project`). Derived from the field name; purely cosmetic.
   */
  group: string;
}

export interface ApiArgDoc {
  name: string;
  type: string;
  required: boolean;
  description: string | null;
}

/** The whole catalog, split by operation for the two docs columns. */
export interface ApiCatalog {
  queries: ApiFieldDoc[];
  mutations: ApiFieldDoc[];
  /** SDL of the schema, for the "raw schema" view. */
  sdl: string;
  /**
   * Full introspection result (the `__schema` JSON). Shipped to the client so
   * the playground editor can rebuild the schema with `buildClientSchema` and
   * drive real, schema-aware validation + autocomplete — no extra dependency,
   * since `graphql` is already bundled.
   */
  introspection: unknown;
}

/**
 * Read the `authScopes` Pothos stashed on the field and normalise it to a
 * {@link FieldScope}. Unknown / absent scope ⇒ `public`.
 */
function scopeOf(field: GraphQLField<unknown, unknown>): FieldScope {
  const opts = (
    field.extensions as { pothosOptions?: { authScopes?: unknown } } | undefined
  )?.pothosOptions;
  const raw = opts?.authScopes as
    | { loggedIn?: boolean; capability?: Capability; instanceAdmin?: boolean }
    | undefined;
  if (!raw || typeof raw !== "object") return { kind: "public" };
  if (raw.instanceAdmin) return { kind: "instanceAdmin" };
  if (raw.capability) return { kind: "capability", capability: raw.capability };
  if (raw.loggedIn) return { kind: "loggedIn" };
  return { kind: "public" };
}

/**
 * Bucket a field under a coarse domain for grouped rendering. We match the
 * field name against the known domain nouns (longest first so `createProject`
 * lands in `project`, not a shorter accidental match). Falls back to `general`.
 */
const GROUPS = [
  "deployment",
  "registration",
  "notification",
  "registry",
  "database",
  "template",
  "activity",
  "instance",
  "backup",
  "member",
  "domain",
  "server",
  "github",
  "project",
  "shared",
  "update",
  "token",
  "team",
  "user",
  "app",
  "dev",
  "env",
  "s3",
];

function groupOf(name: string): string {
  const lower = name.toLowerCase();
  for (const g of GROUPS) {
    if (lower.includes(g)) return g;
  }
  return "general";
}

function argDoc(arg: GraphQLArgument): ApiArgDoc {
  const type = arg.type.toString();
  return {
    name: arg.name,
    type,
    // A NonNull type renders with a trailing `!` and has no default.
    required: type.endsWith("!") && arg.defaultValue === undefined,
    description: arg.description ?? null,
  };
}

function fieldDoc(
  field: GraphQLField<unknown, unknown>,
  operation: "query" | "mutation",
): ApiFieldDoc {
  return {
    name: field.name,
    operation,
    description: field.description ?? null,
    returnType: field.type.toString(),
    args: field.args.map(argDoc),
    scope: scopeOf(field),
    group: groupOf(field.name),
  };
}

function fieldsOf(
  type: GraphQLObjectType | null | undefined,
  operation: "query" | "mutation",
): ApiFieldDoc[] {
  if (!type || !isObjectType(type)) return [];
  return Object.values(type.getFields())
    .map((f) => fieldDoc(f, operation))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build the documentation catalog from the live, assembled schema. Computed on
 * demand (the schema is a singleton built at module load, so this is just a
 * cheap walk) — no caching needed for a settings page.
 */
export function buildApiCatalog(): ApiCatalog {
  // The introspection JSON the client rebuilds into a GraphQLSchema. Run with a
  // null context — introspection only reads the type system, never a resolver,
  // so it is safe and complete regardless of who is viewing.
  const rawIntrospection = executeSync({
    schema,
    document: parse(getIntrospectionQuery()),
  }).data;

  // graphql-js builds parts of the introspection result with `Object.create(null)`
  // (null-prototype maps). React Server Components reject those when serialising
  // props to a Client Component ("Only plain objects … can be passed"). Round-trip
  // through JSON so every node is a plain object before it crosses the boundary.
  const introspection = JSON.parse(JSON.stringify(rawIntrospection));

  return {
    queries: fieldsOf(schema.getQueryType(), "query"),
    mutations: fieldsOf(schema.getMutationType(), "mutation"),
    sdl: printSchema(schema),
    introspection,
  };
}
