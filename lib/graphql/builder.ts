import SchemaBuilder from "@pothos/core";
import ScopeAuthPlugin from "@pothos/plugin-scope-auth";
import { DateTimeResolver, JSONResolver } from "graphql-scalars";
import type { GraphQLContext } from "./context";
import type { Capability } from "@/lib/types";

/**
 * The code-first schema builder. One builder, imported by every domain module
 * in `lib/graphql/types/*`, which attach their object types, queries and
 * mutations to it. `schema.ts` imports them all and calls `toSchema()`.
 *
 * Scopes mirror the capability model: `authScopes: { capability: "deploy" }`
 * on a field rejects callers lacking that capability with a clean GraphQL
 * error. The data layer's own `requireCapability` stays as defense-in-depth —
 * the scope here is for a typed, introspectable API contract.
 */
export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  Scalars: {
    DateTime: { Input: Date; Output: Date | string };
    JSON: { Input: unknown; Output: unknown };
  };
  AuthScopes: {
    /** Caller is authenticated (cookie session or valid API token). */
    loggedIn: boolean;
    /** Caller holds the given capability in the active team. */
    capability: Capability;
    /** Caller is a global instance admin. */
    instanceAdmin: boolean;
  };
}>({
  plugins: [ScopeAuthPlugin],
  scopeAuth: {
    authScopes: (ctx) => ({
      loggedIn: !!ctx.viewer,
      capability: (cap: Capability) => ctx.capabilities.includes(cap),
      instanceAdmin: !!ctx.viewer?.isInstanceAdmin,
    }),
  },
});

builder.addScalarType("DateTime", DateTimeResolver);
builder.addScalarType("JSON", JSONResolver);

builder.queryType({});
builder.mutationType({});
