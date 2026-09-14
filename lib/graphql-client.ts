"use client";

export class GraphQLRequestError extends Error {
  constructor(
    message: string,
    readonly errors: {
      message: string;
      extensions?: Record<string, unknown>;
    }[],
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
import { TEAM_HEADER, teamSlugFromPath } from "./team-path";
import { assertVariablesDeclared } from "./graphql-vars";

// `/api/graphql` is flat, so this header is what tells the server which team the request is for (lib/membership.ts).
function teamHeader(teamId?: string): Record<string, string> {
  const slug =
    teamId ??
    (typeof location === "undefined"
      ? null
      : teamSlugFromPath(location.pathname));
  return slug ? { [TEAM_HEADER]: slug } : {};
}

// GqlOptions - per-call options; `teamId` sends the request to that team, not the page's.
export interface GqlOptions {
  teamId?: string;
  signal?: AbortSignal;
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

function unreachable(): ServerUnreachableError {
  reportServerUnreachable();
  return new ServerUnreachableError();
}

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

// gqlAction - run an operation and box the outcome as an `ActionResult`, the shape the UI's call sites branch on.
export async function gqlAction<TData = unknown, TPick = TData>(
  query: string,
  variables?: Record<string, unknown>,
  pick?: (data: TData) => TPick,
  opts?: GqlOptions,
): Promise<ActionResult<TPick>> {
  try {
    const data = await gql<TData>(query, variables, opts?.signal, opts);
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
  opts?: GqlOptions,
): Promise<TData> {
  assertVariablesDeclared(query, variables);
  // Already latched offline: refuse up front rather than making the user wait out a raw "Failed to fetch".
  if (isServerDisconnected()) throw new ServerUnreachableError();

  let res: Response;
  try {
    res = await fetch("/api/graphql", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...teamHeader(opts?.teamId),
      },
      body: JSON.stringify({ query, variables }),
      credentials: "same-origin",
      signal,
    });
  } catch (e) {
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

// gqlSubscribe - open a subscription over Server-Sent Events against the same `/api/graphql` endpoint.
export function gqlSubscribe<TData = unknown>(
  query: string,
  variables: Record<string, unknown> | undefined,
  onData: (data: TData) => void,
  onError?: (error: Error) => void,
  opts?: Pick<GqlOptions, "teamId">,
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
          ...teamHeader(opts?.teamId),
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
      // A gateway status or an HTML body means the proxy answered for an app that is not there: an outage, not a failed subscription.
      const html = (res.headers.get("content-type") ?? "").includes(
        "text/html",
      );
      if (res.status >= 500 || html || !res.body) throw unreachable();
      throw new GraphQLRequestError(`Subscription failed (${res.status})`, []);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // SSE frames are separated by a blank line; each frame is a set of `field: value` lines.
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

        // A non-JSON frame means the stream got cut: drop it rather than let a raw SyntaxError reach `onError`.
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

  (async () => {
    let backoff = 1000;
    while (!closed) {
      // Once the connection guard has latched the UI, stop self-healing: the overlay promises nothing reconnects until a reload.
      if (isServerDisconnected()) return;
      try {
        await connect();
        // A clean `complete` or EOF should not happen unless the app was deleted, so stop trying.
        if (!closed) return;
      } catch (e) {
        if (closed || controller.signal.aborted) return;
        // `connect()` already swapped the raw failure for the custom message, so this is safe to show verbatim.
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
