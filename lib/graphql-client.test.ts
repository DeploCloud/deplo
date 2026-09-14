import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import { gql, gqlAction, GraphQLRequestError } from "./graphql-client";
import {
  SERVER_UNREACHABLE_MESSAGE,
  ServerUnreachableError,
  __resetServerConnectionForTests,
  checkServerConnection,
  getServerConnectionSnapshot,
} from "./server-connection";

const HTML_ERROR_PAGE =
  "<!DOCTYPE html>\n<html><head><title>502 Bad Gateway</title></head><body>Web server is down</body></html>";

const realFetch = globalThis.fetch;
let requested: string[] = [];

function stubFetch(
  handler: (url: string) => Promise<Response> | Response,
): void {
  requested = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : String(input);
    requested.push(url);
    if (url === "/api/health") return new Response("", { status: 502 });
    return handler(url);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(async () => {
  await __resetServerConnectionForTests();
});

afterEach(async () => {
  // Drain with the stub installed: a retried ping 1.5s later would land in the NEXT test.
  await __resetServerConnectionForTests();
  globalThis.fetch = realFetch;
});

test("a proxy's HTML error page never surfaces as a JSON parse error", async () => {
  stubFetch(
    () =>
      new Response(HTML_ERROR_PAGE, {
        status: 502,
        headers: { "content-type": "text/html" },
      }),
  );

  await assert.rejects(
    () => gql("{ me { id } }"),
    (e: unknown) => {
      assert.ok(e instanceof ServerUnreachableError, `got ${String(e)}`);
      assert.equal(e.message, SERVER_UNREACHABLE_MESSAGE);
      assert.doesNotMatch(e.message, /DOCTYPE|JSON|token/i);
      return true;
    },
  );
});

test("an HTML body with a 200 status is treated as an outage too", async () => {
  // A proxy or captive portal can answer 200 with its own page.
  stubFetch(() => new Response(HTML_ERROR_PAGE, { status: 200 }));
  await assert.rejects(() => gql("{ me { id } }"), ServerUnreachableError);
});

test("a network-level failure carries the custom message", async () => {
  stubFetch(() => {
    throw new TypeError("Failed to fetch");
  });

  await assert.rejects(
    () => gql("{ me { id } }"),
    (e: unknown) =>
      e instanceof ServerUnreachableError &&
      e.message === SERVER_UNREACHABLE_MESSAGE,
  );
});

test("a failed request tells the connection guard, so the notification comes up", async () => {
  stubFetch(() => {
    throw new TypeError("Failed to fetch");
  });

  await assert.rejects(() => gql("{ me { id } }"), ServerUnreachableError);
  // Run the check to completion so the two-failed-pings latch shows without the retry delay.
  await checkServerConnection();
  assert.equal(getServerConnectionSnapshot(), "disconnected");
  assert.ok(
    requested.includes("/api/health"),
    "the guard must have pinged health",
  );
});

test("once paused, an interaction is refused without touching the network", async () => {
  stubFetch(() => jsonResponse({ data: { ok: true } }));
  // Latch: /api/health answers 502 twice.
  await checkServerConnection();
  assert.equal(getServerConnectionSnapshot(), "disconnected");

  const before = requested.length;
  await assert.rejects(
    () => gql('mutation { redeploy(appId: "prj_1") { id } }'),
    (e: unknown) =>
      e instanceof ServerUnreachableError &&
      e.message === SERVER_UNREACHABLE_MESSAGE,
  );
  assert.equal(requested.length, before, "no request may leave while paused");
});

test("gqlAction boxes the paused message for the toast call sites", async () => {
  stubFetch(() => new Response(HTML_ERROR_PAGE, { status: 504 }));

  const res = await gqlAction('mutation { deleteApp(id: "prj_1") }');
  assert.equal(res.ok, false);
  assert.equal(res.ok === false && res.error, SERVER_UNREACHABLE_MESSAGE);
});

test("a real GraphQL error still reaches the user verbatim", async () => {
  stubFetch(() =>
    jsonResponse({
      errors: [{ message: "You don't have permission to deploy" }],
    }),
  );

  await assert.rejects(
    () => gql('mutation { redeploy(appId: "prj_1") { id } }'),
    (e: unknown) =>
      e instanceof GraphQLRequestError &&
      e.message === "You don't have permission to deploy",
  );
  assert.equal(
    getServerConnectionSnapshot(),
    "connected",
    "a server answer is not an outage",
  );
});

test("an aborted request stays an abort, not an outage", async () => {
  const controller = new AbortController();
  stubFetch(() => {
    controller.abort();
    throw new DOMException("The operation was aborted.", "AbortError");
  });

  await assert.rejects(
    () => gql("{ me { id } }", undefined, controller.signal),
    (e: unknown) => e instanceof DOMException && e.name === "AbortError",
  );
  assert.equal(getServerConnectionSnapshot(), "connected");
});

test("a successful query is untouched", async () => {
  stubFetch(() => jsonResponse({ data: { me: { id: "usr_1" } } }));
  const data = await gql<{ me: { id: string } }>("{ me { id } }");
  assert.deepEqual(data, { me: { id: "usr_1" } });
});
