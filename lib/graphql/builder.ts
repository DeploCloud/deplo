// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import SchemaBuilder from "@pothos/core";
import ScopeAuthPlugin from "@pothos/plugin-scope-auth";
import { DateTimeResolver, JSONResolver } from "graphql-scalars";
import type { GraphQLContext } from "./context";
import type { Capability } from "@/lib/types";

/**
 * The code-first schema builder.
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
      // Instance administration is opt-in PER TOKEN, never inherited from the person (see
      // `tokenHoldsInstanceAdmin` in lib/membership.ts).
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
