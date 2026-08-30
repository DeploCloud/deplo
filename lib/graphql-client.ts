"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Minimal typed GraphQL client for the browser UI. Errors: a GraphQL error
 * response throws an `Error` carrying the first message, so call sites keep the
 * familiar try/catch they used to get from a thrown server action.
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
import {
  isServerDisconnected,
  reportServerUnreachable,
  ServerUnreachableError,
} from "./server-connection";

/** An abort is the caller's own doing, never a connection problem. */
function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/**
 * Turn "the server is gone" into the one custom message, and tell the
 * connection guard so it raises the notification (and pauses navigation) if it
 * hasn't already. Returns the error to throw.
 */
function unreachable(): ServerUnreachableError {
  reportServerUnreachable();
  return new ServerUnreachableError();
}

/**
 * Read a response that MUST be JSON - `/api/graphql` never answers anything else.
 */
async function readJsonBody<T>(res: Response): Promise<T> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    if (isAbort(e)) throw e;
    throw unreachable();
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw unreachable();
  }
}

/**
 * Run a GraphQL operation and box the outcome as an `ActionResult` - the shape the
 * UI's call sites already branch on (`if (res.ok) … else res.error`).
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
  // Already latched offline: the request can only fail, so refuse it up front with
  // the custom message instead of making the user wait out a timeout for a raw
  // "Failed to fetch".
  if (isServerDisconnected()) throw new ServerUnreachableError();

  let res: Response;
  try {
    res = await fetch("/api/graphql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      credentials: "same-origin",
      signal,
    });
  } catch (e) {
    // An abort is the caller's; anything else at the network level means the
    // panel's web server may be gone - let the connection guard verify and
    // raise the notification.
    if (isAbort(e)) throw e;
    throw unreachable();
  }

  const json = await readJsonBody<{
    data?: TData;
    errors?: { message: string }[];
  }>(res);

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
 * `/api/graphql` endpoint.
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
    let res: Response;
    try {
      res = await fetch("/api/graphql", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify({ query, variables }),
        credentials: "same-origin",
        signal: controller.signal,
      });
    } catch (e) {
      if (isAbort(e)) throw e;
      throw unreachable();
    }

    if (!res.ok || !res.body) {
      // A gateway status or an HTML body means we never reached the app - the
      // proxy answered for a server that isn't there. Report it as an outage
      // rather than as a subscription that failed on its own merits.
      const html = (res.headers.get("content-type") ?? "").includes(
        "text/html",
      );
      if (res.status >= 500 || html || !res.body) throw unreachable();
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
          else if (line.startsWith("data:"))
            dataLines.push(line.slice(5).trim());
        }
        if (event === "complete") return;
        if (event !== "next" || dataLines.length === 0) continue;

        // Our own frames are always JSON. One that isn't means the stream got
        // cut and something else's bytes landed in it - drop the frame rather
        // than letting a raw SyntaxError reach `onError` (and a toast).
        let json: { data?: TData; errors?: { message: string }[] };
        try {
          json = JSON.parse(dataLines.join("\n")) as typeof json;
        } catch {
          continue;
        }
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
      // Once the connection guard has latched the UI behind its blocking overlay, stop
      // self-healing: retrying would keep hammering a dead server (and spawning error
      // toasts) behind a screen that promises nothing reconnects until the user reloads.
      if (isServerDisconnected()) return;
      try {
        await connect();
        // Clean `complete` or EOF - for a status stream that should not happen
        // unless the project was deleted; stop trying in that case.
        if (!closed) return;
      } catch (e) {
        if (closed || controller.signal.aborted) return;
        // `connect()` has already reported the outage and swapped the raw
        // failure for the custom message, so whatever surfaces here is safe to
        // show verbatim.
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
