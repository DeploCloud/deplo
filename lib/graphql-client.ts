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

/**
 * Open a GraphQL subscription over Server-Sent Events against the same
 * `/api/graphql` endpoint. GraphQL Yoga negotiates `text/event-stream` for the
 * operation and streams each result as an `event: next\ndata: {…}\n\n` frame;
 * we POST (so the query lives in the body and the session cookie rides along,
 * same-origin) and parse the SSE frames off the response body stream.
 *
 * `onData` is called with `data` for every emitted result. Returns an
 * unsubscribe function that aborts the stream — call it on unmount. Network
 * blips are reconnected with a short backoff until unsubscribed, so a dropped
 * SSE connection self-heals (the subscription re-emits its current snapshot on
 * resubscribe). Terminal GraphQL errors are reported via `onError`.
 */
export function gqlSubscribe<TData = unknown>(
  query: string,
  variables: Record<string, unknown> | undefined,
  onData: (data: TData) => void,
  onError?: (error: Error) => void,
): () => void {
  const controller = new AbortController();
  let closed = false;

  async function connect(): Promise<void> {
    const res = await fetch("/api/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify({ query, variables }),
      credentials: "same-origin",
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      throw new GraphQLRequestError(`Subscription failed (${res.status})`, []);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // SSE frames are separated by a blank line; each frame is a set of
    // `field: value` lines. We only care about `event:` and `data:`.
    while (!closed) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        let event = "message";
        const dataLines: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith(":")) continue; // keep-alive ping
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (event === "complete") return;
        if (event !== "next" || dataLines.length === 0) continue;

        const json = JSON.parse(dataLines.join("\n")) as {
          data?: TData;
          errors?: { message: string }[];
        };
        if (json.errors?.length) {
          throw new GraphQLRequestError(json.errors[0].message, json.errors);
        }
        if (json.data !== undefined) onData(json.data as TData);
      }
    }
  }

  // Reconnect loop: keep the subscription alive across transient drops until
  // the caller unsubscribes (which aborts and sets `closed`).
  (async () => {
    let backoff = 1000;
    while (!closed) {
      try {
        await connect();
        // Clean `complete` or EOF — for a status stream that should not happen
        // unless the project was deleted; stop trying in that case.
        if (!closed) return;
      } catch (e) {
        if (closed || controller.signal.aborted) return;
        onError?.(e instanceof Error ? e : new Error(String(e)));
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  })();

  return () => {
    closed = true;
    controller.abort();
  };
}
