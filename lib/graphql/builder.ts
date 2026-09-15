import SchemaBuilder from "@pothos/core";
import ScopeAuthPlugin from "@pothos/plugin-scope-auth";
import { DateTimeResolver, JSONResolver } from "graphql-scalars";
import type { GraphQLContext } from "./context";
import type { Capability } from "@/lib/types/identity";

export const builder = new SchemaBuilder<{
  Context: GraphQLContext;
  Scalars: {
    DateTime: { Input: Date; Output: Date | string };
    JSON: { Input: unknown; Output: unknown };
  };
  AuthScopes: {
    loggedIn: boolean;
    capability: Capability;
    instanceAdmin: boolean;
  };
}>({
  plugins: [ScopeAuthPlugin],
  scopeAuth: {
    authScopes: (ctx) => ({
      loggedIn: !!ctx.viewer,
      capability: (cap: Capability) => ctx.capabilities.includes(cap),
      // Instance admin is opt-in PER TOKEN, never inherited from the person holding it.
      instanceAdmin:
        !!ctx.viewer?.isInstanceAdmin &&
        (!ctx.identity?.token || ctx.identity.token.instanceAdmin),
    }),
  },
});

builder.addScalarType("DateTime", DateTimeResolver);
builder.addScalarType("JSON", JSONResolver);

builder.queryType({});
builder.mutationType({});
