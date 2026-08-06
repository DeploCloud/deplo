import "server-only";

import { createYoga, type Plugin } from "graphql-yoga";
import { maxDepthPlugin } from "@escape.tech/graphql-armor-max-depth";
import { maxAliasesPlugin } from "@escape.tech/graphql-armor-max-aliases";
import { costLimitPlugin } from "@escape.tech/graphql-armor-cost-limit";
import { schema } from "./schema";
import { buildContext, type GraphQLContext } from "./context";
import { maskError } from "./mask-error";
import {
  runWithIdentity,
  type RequestIdentity,
} from "@/lib/auth/request-context";

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
    setSubscribeFn(async (subArgs) => {
      const result = await runWithIdentity(identity, () =>
        subscribeFn(subArgs),
      );
      return isAsyncIterable(result)
        ? withIdentityPerTick(result, identity)
        : result;
    });
  },
};

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return typeof (v as AsyncIterable<unknown>)?.[Symbol.asyncIterator] === "function";
}

/**
 * Re-apply the identity around every TICK of a subscription, not just around the
 * iterator's creation.
 *
 * An async generator body does NOT inherit the async context of whoever created
 * it — it runs in the context of whoever calls `next()`, which for a
 * long-lived SSE response is the server's event loop, long after
 * `runWithIdentity` returned. Measured, not assumed: without this the store is
 * `undefined` on every tick including the first, so a project-scoped token would
 * stream an app it cannot otherwise see. Wrapping each `next()` restores it on
 * every tick and across every await inside the body.
 */
function withIdentityPerTick<T>(
  source: AsyncIterable<T>,
  identity: RequestIdentity,
): AsyncIterableIterator<T> {
  const it = source[Symbol.asyncIterator]() as AsyncIterator<T>;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: (...a) => runWithIdentity(identity, () => it.next(...a)),
    return: it.return
      ? (v?: unknown) => runWithIdentity(identity, () => it.return!(v))
      : undefined,
    throw: it.throw
      ? (e?: unknown) => runWithIdentity(identity, () => it.throw!(e))
      : undefined,
  } as AsyncIterableIterator<T>;
}

/**
 * A POST must be JSON. Nothing else is a legitimate way to reach this endpoint,
 * and the alternatives Yoga's body parsers accept are exactly the content types
 * a browser can send CROSS-ORIGIN with no preflight: `application/x-www-form-
 * urlencoded`, `multipart/form-data`, `text/plain`. A form on any site could
 * therefore POST a mutation and the session cookie would ride along.
 *
 * `SameSite=Lax` on the session cookie is what stops that today, but it is a
 * default of the auth library rather than something this endpoint asserts, and
 * a CSRF defence that lives in somebody else's config is one nobody notices
 * losing. Refusing the content type costs one comparison and removes the class:
 * `application/json` is not CORS-simple, so it cannot be sent cross-origin
 * without a preflight that `cors: false` never answers.
 *
 * GET is untouched — GraphiQL's HTML and query-over-GET both still work, and a
 * mutation over GET is refused by the GraphQL-over-HTTP spec anyway.
 */
const requireJsonPost: Plugin = {
  onRequest({ request, endResponse, fetchAPI }) {
    if (request.method !== "POST") return;
    const type = request.headers.get("content-type") ?? "";
    if (type.split(";")[0].trim().toLowerCase() === "application/json") return;
    endResponse(
      new fetchAPI.Response(
        JSON.stringify({
          errors: [
            {
              message:
                "A GraphQL request must be sent as application/json. Set `Content-Type: application/json`.",
            },
          ],
        }),
        { status: 415, headers: { "content-type": "application/json" } },
      ),
    );
  },
};

export const yoga = createYoga({
  schema,
  // Served from the Next route handler at this path; GraphiQL lives here too.
  graphqlEndpoint: "/api/graphql",
  // The panel is same-origin; never reflect a request Origin back with
  // credentials allowed (that would let any site read/mutate with the cookie).
  cors: false,
  context: ({ request }) => buildContext(request),
  plugins: [
    requireJsonPost,
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
