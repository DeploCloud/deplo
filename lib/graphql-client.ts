"use client";

/**
 * Minimal typed GraphQL client for the browser UI.
 *
 * Same-origin POST to /api/graphql, so the session cookie is sent automatically
 * — no token handling in the app itself (tokens are for external API clients).
 *
 * Errors: a GraphQL error response throws an `Error` carrying the first
 * message, so call sites keep the familiar try/catch they used to get from a
 * thrown server action. This replaces the old `ActionResult` `{ ok, error }`
 * box — the message text (e.g. "You don't have permission to deploy") is
 * preserved verbatim by the server's masked error formatter.
 *
 * Cache: server actions used to call `revalidatePath`. The GraphQL API has no
 * Next cache to revalidate, so after a mutation the caller refreshes the RSC
 * tree with `useRouter().refresh()` (see `useGraphqlMutation`), which re-runs
 * the server-side data reads that render the page.
 */

export class GraphQLRequestError extends Error {
  constructor(
    message: string,
    readonly errors: { message: string }[],
  ) {
    super(message);
    this.name = "GraphQLRequestError";
  }
}

import type { ActionResult } from "./result";

/**
 * Run a GraphQL operation and box the outcome as an `ActionResult` — the shape
 * the UI's call sites already branch on (`if (res.ok) … else res.error`). This
 * is the drop-in replacement for calling a server action: swap
 * `await someAction(args)` for `await gqlAction(QUERY, vars, d => d.field)`.
 * The optional `pick` projects the response data to what the call site wants.
 */
export async function gqlAction<TData = unknown, TPick = TData>(
  query: string,
  variables?: Record<string, unknown>,
  pick?: (data: TData) => TPick,
): Promise<ActionResult<TPick>> {
  try {
    const data = await gql<TData>(query, variables);
    return { ok: true, data: pick ? pick(data) : (data as unknown as TPick) };
  } catch (e) {
    const error =
      e instanceof GraphQLRequestError
        ? e.message
        : e instanceof Error
          ? e.message
          : "Something went wrong";
    return { ok: false, error };
  }
}

export async function gql<TData = unknown>(
  query: string,
  variables?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TData> {
  const res = await fetch("/api/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    credentials: "same-origin",
    signal,
  });

  const json = (await res.json()) as {
    data?: TData;
    errors?: { message: string }[];
  };

  if (json.errors?.length) {
    throw new GraphQLRequestError(json.errors[0].message, json.errors);
  }
  if (!res.ok) {
    throw new GraphQLRequestError(`Request failed (${res.status})`, []);
  }
  return json.data as TData;
}
