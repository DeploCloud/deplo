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
 * An INFRASTRUCTURE error whose message must never reach a client: a Drizzle
 * wrapper (its message embeds the raw SQL + bound params — which can include
 * secret values), a Postgres error (SQLSTATE `.code` + table/column identifiers),
 * or a Node/gRPC transport error (a string `.code` like `ECONNREFUSED` or a
 * numeric gRPC status — dial addresses, cert fingerprints). These are masked.
 */
function isInternalError(e: unknown): boolean {
  if (!(e instanceof Error)) return true; // a non-Error throw is never user copy
  if (e.name === "DrizzleQueryError" || e.message.startsWith("Failed query:"))
    return true;
  // pg carries a string SQLSTATE; gRPC/Node carry a string or numeric code. A
  // plain `new Error("You don't have permission")` has no `code`, so it is kept.
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" || typeof code === "number";
}

/**
 * Never leak internals, but PRESERVE the repo's "surface the server's message
 * verbatim" contract for the intentional, user-facing errors resolvers and the
 * data layer throw ("You don't have permission to deploy", "Too many attempts",
 * validation messages). Those are plain `Error`s (or `GraphQLError`s) with no
 * infrastructure `.code`, so their message is forwarded; a Drizzle/pg/transport
 * error (see {@link isInternalError}) is masked to a generic string and logged
 * server-side only.
 */
function userFacingMessage(error: unknown): string | null {
  if (error instanceof GraphQLError) {
    const orig = error.originalError;
    // A GraphQLError our code threw directly (no non-GraphQL cause) is user copy.
    if (!orig || orig instanceof GraphQLError) return error.message;
    error = orig; // otherwise inspect the wrapped cause below
  }
  if (error instanceof Error && !isInternalError(error)) return error.message;
  return null;
}

function maskError(error: unknown): GraphQLError {
  const msg = userFacingMessage(error);
  if (msg != null) return new GraphQLError(msg);
  console.error("[graphql] masked internal error:", error);
  return new GraphQLError("Something went wrong");
}

export const yoga = createYoga({
  schema,
  // Served from the Next route handler at this path; GraphiQL lives here too.
  graphqlEndpoint: "/api/graphql",
  // The panel is same-origin; never reflect a request Origin back with
  // credentials allowed (that would let any site read/mutate with the cookie).
  cors: false,
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
