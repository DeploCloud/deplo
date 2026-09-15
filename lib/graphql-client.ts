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

function teamHeader(teamId?: string): Record<string, string> {
  const slug =
    teamId ??
    (typeof location === "undefined"
      ? null
      : teamSlugFromPath(location.pathname));
  return slug ? { [TEAM_HEADER]: slug } : {};
}

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
      const html = (res.headers.get("content-type") ?? "").includes(
        "text/html",
      );
      if (res.status >= 500 || html || !res.body) throw unreachable();
      throw new GraphQLRequestError(`Subscription failed (${res.status})`, []);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

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
          if (line.startsWith(":")) continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:"))
            dataLines.push(line.slice(5).trim());
        }
        if (event === "complete") return;
        if (event !== "next" || dataLines.length === 0) continue;

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
      if (isServerDisconnected()) return;
      try {
        await connect();
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
