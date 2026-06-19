import "server-only";

import { createYoga, type Plugin } from "graphql-yoga";
import { GraphQLError } from "graphql";
import { maxDepthPlugin } from "@escape.tech/graphql-armor-max-depth";
import { maxAliasesPlugin } from "@escape.tech/graphql-armor-max-aliases";
import { costLimitPlugin } from "@escape.tech/graphql-armor-cost-limit";
import { schema } from "./schema";
import { buildContext, type GraphQLContext } from "./context";
import { runWithIdentity } from "@/lib/auth/request-context";

/**
 * Wrap the operation's execution in the bearer-token identity (when present) so
 * every data-layer call inside the resolvers resolves the token's principal
 * rather than cookies. `buildContext` only establishes identity for the brief
 * context-build; the resolvers run later, in a fresh async context, so the ALS
 * override must be re-applied around execution itself.
 */
const identityPlugin: Plugin<GraphQLContext> = {
  onExecute({ args, setExecuteFn, executeFn }) {
    const identity = (args.contextValue as GraphQLContext).identity;
    if (!identity) return;
    setExecuteFn((execArgs) =>
      runWithIdentity(identity, () => executeFn(execArgs)),
    );
  },
  onSubscribe({ args, setSubscribeFn, subscribeFn }) {
    const identity = (args.contextValue as GraphQLContext).identity;
    if (!identity) return;
    setSubscribeFn((subArgs) =>
      runWithIdentity(identity, () => subscribeFn(subArgs)),
    );
  },
};

/**
 * Never leak internal stack traces. A resolver that throws a plain `Error`
 * (which is how the data layer reports user-facing failures like "You don't
 * have permission to deploy") keeps its message — that was the contract the old
 * `run()`/`ActionResult` wrapper gave. Anything that is NOT already a
 * GraphQLError is re-wrapped with its message preserved but the stack dropped.
 */
function maskError(error: unknown): GraphQLError {
  if (error instanceof GraphQLError) {
    const orig = error.originalError;
    if (!orig || orig instanceof GraphQLError) return error;
    // A resolver threw a normal Error — surface its message, hide the stack.
    return new GraphQLError(orig.message, {
      nodes: error.nodes,
      source: error.source,
      positions: error.positions,
      path: error.path,
    });
  }
  return new GraphQLError(
    error instanceof Error ? error.message : "Something went wrong",
  );
}

export const yoga = createYoga({
  schema,
  // Served from the Next route handler at this path; GraphiQL lives here too.
  graphqlEndpoint: "/api/graphql",
  context: ({ request }) => buildContext(request),
  plugins: [
    identityPlugin,
    // Public-API hardening: bound query complexity so an external client can't
    // craft a pathological query (deep nesting, alias amplification, huge cost).
    maxDepthPlugin({ n: 12 }),
    maxAliasesPlugin({ n: 30 }),
    costLimitPlugin({ maxCost: 5000 }),
  ],
  maskedErrors: { maskError },
  // Next.js owns the HTTP layer; let Yoga produce a Fetch Response.
  fetchAPI: { Response },
  graphiql: {
    title: "Deplo API",
    defaultQuery: /* GraphQL */ `# Welcome to the Deplo GraphQL API.
# Browser requests use your session cookie automatically.
# External clients send:  Authorization: Bearer deplo_xxx
query Me {
  me { id username name role isInstanceAdmin }
  apiContext
}`,
  },
});
