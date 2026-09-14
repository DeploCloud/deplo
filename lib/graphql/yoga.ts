import "server-only";

import { createYoga, type Plugin } from "graphql-yoga";
import { maxDepthPlugin } from "@escape.tech/graphql-armor-max-depth";
import { maxAliasesPlugin } from "@escape.tech/graphql-armor-max-aliases";
import { costLimitPlugin } from "@escape.tech/graphql-armor-cost-limit";
import { schema } from "./schema";
import { buildContext, type GraphQLContext } from "./context";
import { maskError } from "./mask-error";
import { getOperationAST } from "graphql";
import { runWithIdentity } from "@/lib/auth/request-context";
import { withoutRequestCache } from "@/lib/request-cache";

// Run the operation inside the bearer-token identity, so lib/data resolves it, not cookies.
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
        ? perTick(result, (fn) => runWithIdentity(identity, fn))
        : result;
    });
  },
};

// A mutation must read what it just wrote, and a subscription outlives every gate it passed.
const uncachedWrites: Plugin<GraphQLContext> = {
  onExecute({ args, setExecuteFn, executeFn }) {
    const op = getOperationAST(args.document, args.operationName)?.operation;
    if (op !== "mutation") return;
    setExecuteFn((execArgs) => withoutRequestCache(() => executeFn(execArgs)));
  },
  onSubscribe({ setSubscribeFn, subscribeFn }) {
    setSubscribeFn(async (subArgs) => {
      const result = await withoutRequestCache(() => subscribeFn(subArgs));
      return isAsyncIterable(result)
        ? perTick(result, withoutRequestCache)
        : result;
    });
  },
};

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return (
    typeof (v as AsyncIterable<unknown>)?.[Symbol.asyncIterator] === "function"
  );
}

// Re-apply `wrap` around every TICK, not only around the iterator's creation.
function perTick<T>(
  source: AsyncIterable<T>,
  wrap: <R>(fn: () => R) => R,
): AsyncIterableIterator<T> {
  const it = source[Symbol.asyncIterator]() as AsyncIterator<T>;
  return {
    [Symbol.asyncIterator]() {
      return this;
    },
    next: (...a) => wrap(() => it.next(...a)),
    return: it.return ? (v?: unknown) => wrap(() => it.return!(v)) : undefined,
    throw: it.throw ? (e?: unknown) => wrap(() => it.throw!(e)) : undefined,
  } as AsyncIterableIterator<T>;
}

// A POST must be JSON: a cross-site form could otherwise post a mutation with the cookie.
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
  graphqlEndpoint: "/api/graphql",
  // Same-origin panel: reflecting an Origin with credentials would let any site use the cookie.
  cors: false,
  context: ({ request }) => buildContext(request),
  plugins: [
    requireJsonPost,
    identityPlugin,
    uncachedWrites,
    // Public-API hardening: bound depth, alias amplification and cost.
    maxDepthPlugin({ n: 12 }),
    maxAliasesPlugin({ n: 30 }),
    costLimitPlugin({ maxCost: 5000 }),
  ],
  maskedErrors: { maskError },
  fetchAPI: { Response },
  // The IDE loads its bundle from a public CDN into the panel's origin: development only.
  graphiql: process.env.NODE_ENV === "development" && {
    title: "Deplo API",
    defaultQuery: /* GraphQL */ `
      # Welcome to the Deplo GraphQL API.
      # Browser requests use your session cookie automatically.
      # External clients send:  Authorization: Bearer deplo_xxx
      query Me {
        me {
          id
          username
          name
          role
          isInstanceAdmin
        }
        apiContext
      }
    `,
  },
});
