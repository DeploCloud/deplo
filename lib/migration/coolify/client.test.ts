// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __resetCoolifyRateLimitForTest,
  listProjects,
  panelFromHealth,
  stopResource,
} from "./client";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
  normalizeSourceBaseUrl,
} from "../transport";

/**
 * The transport half of the Coolify adapter. Every refusal here is a real body
 * from Coolify's own middlewares, which is why they are matched by their words.
 */

const cred = {
  kind: "coolify" as const,
  baseUrl: "https://coolify.test",
  apiKey: "3|abcdefghijklmnopqrstuvwxyz012345",
};

function reset(t: { after: (fn: () => void) => void }): void {
  t.after(__resetMigrationFetchForTest);
  t.after(__resetCoolifyRateLimitForTest);
}

function refuses(status: number, message: string): string[] {
  const seen: string[] = [];
  __setMigrationFetchForTest(async (url) => {
    seen.push(url);
    return new Response(JSON.stringify({ message }), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

test("the address is normalised however the API path was typed", () => {
  assert.equal(
    normalizeSourceBaseUrl("https://coolify.test/api/v1"),
    "https://coolify.test",
  );
  assert.equal(
    normalizeSourceBaseUrl("coolify.test/api/"),
    "https://coolify.test",
  );
  assert.throws(
    () => normalizeSourceBaseUrl("https://user:pass@coolify.test"),
    /API key field/,
  );
});

test("a read goes out as a bearer token on /api/v1", async (t) => {
  reset(t);
  let seenUrl = "";
  let seenAuth: string | null = null;
  let seenKey: string | null = null;
  __setMigrationFetchForTest(async (url, init) => {
    seenUrl = url;
    const h = new Headers(init?.headers);
    seenAuth = h.get("authorization");
    seenKey = h.get("x-api-key");
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.deepEqual(await listProjects(cred), []);
  assert.equal(seenUrl, "https://coolify.test/api/v1/projects");
  assert.equal(seenAuth, `Bearer ${cred.apiKey}`);
  // The other platform's header must never ride along with it.
  assert.equal(seenKey, null);
});

test("an API somebody turned off says so, and says where to turn it on", async (t) => {
  reset(t);
  refuses(403, "API is disabled.");
  await assert.rejects(listProjects(cred), (e: Error) => {
    assert.match(e.message, /API is turned off/);
    assert.match(e.message, /Settings/);
    // Coolify's own words are kept, never replaced.
    assert.match(e.message, /Coolify said: API is disabled\./);
    return true;
  });
});

test("an IP allowlist is named as an IP allowlist", async (t) => {
  reset(t);
  refuses(403, "You are not allowed to access the API.");
  await assert.rejects(listProjects(cred), /allowed IP/);
});

test("a token short of a permission says which kind is missing", async (t) => {
  reset(t);
  refuses(403, "Missing required permissions: read:sensitive");
  await assert.rejects(listProjects(cred), (e: Error) => {
    assert.match(e.message, /read:sensitive/);
    return true;
  });
});

test("an unauthenticated call is passed through in Coolify's own words", async (t) => {
  reset(t);
  refuses(401, "Unauthenticated.");
  await assert.rejects(listProjects(cred), (e: Error) => {
    assert.equal(e.message, "Unauthenticated.");
    return true;
  });
});

test("a rate limit is retried once, then given up on with the number", async (t) => {
  reset(t);
  let calls = 0;
  __setMigrationFetchForTest(async () => {
    calls += 1;
    if (calls === 1)
      return new Response(JSON.stringify({ message: "Too Many Attempts." }), {
        status: 429,
        headers: { "retry-after": "0" },
      });
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual(await listProjects(cred), []);
  assert.equal(calls, 2);

  calls = 0;
  __setMigrationFetchForTest(async () => {
    calls += 1;
    return new Response(JSON.stringify({ message: "Too Many Attempts." }), {
      status: 429,
      headers: { "retry-after": "0" },
    });
  });
  await assert.rejects(listProjects(cred), /200 requests a minute/);
  assert.equal(calls, 2);
});

test("a redirect is refused rather than followed", async (t) => {
  reset(t);
  __setMigrationFetchForTest(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://elsewhere.test/login" },
      }),
  );
  await assert.rejects(listProjects(cred), /does not follow redirects/);
});

test("a transport failure arrives readable, naming Coolify", async (t) => {
  reset(t);
  __setMigrationFetchForTest(async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
  });
  await assert.rejects(listProjects(cred), (e: Error) => {
    assert.match(e.message, /Nothing is listening/);
    assert.match(e.message, /:8000/);
    return true;
  });
});

test("a blip is retried, and a wrong address is not", async (t) => {
  // A migration reads the panel hundreds of times. One reset used to end the data
  // phase with every service after it left on empty storage.
  reset(t);
  let calls = 0;
  __setMigrationFetchForTest(async () => {
    calls++;
    if (calls < 3)
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET" },
      });
    return new Response("[]", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  assert.deepEqual(await listProjects(cred), []);
  assert.equal(calls, 3);

  // Nothing listening is not a blip: the Connect screen has to say so at once.
  calls = 0;
  __setMigrationFetchForTest(async () => {
    calls++;
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
  });
  await assert.rejects(listProjects(cred), /Nothing is listening/);
  assert.equal(calls, 1);
});

test("the healthcheck names the panel that answered, or nothing", async (t) => {
  reset(t);
  __setMigrationFetchForTest(
    async () => new Response("<!doctype html><html></html>", { status: 200 }),
  );
  assert.equal(await panelFromHealth("https://panel.test"), null);

  __setMigrationFetchForTest(async () => new Response("OK", { status: 200 }));
  assert.equal(await panelFromHealth("https://panel.test"), "coolify");

  // The other panel answers on the same path in its own words, and reading any
  // 200 as Coolify told people their ADDRESS was wrong when their key was.
  __setMigrationFetchForTest(
    async () => new Response('{"ok":true}', { status: 200 }),
  );
  assert.equal(await panelFromHealth("https://panel.test"), "dokploy");
});

test("the one write is a stop, and it posts", async (t) => {
  reset(t);
  const seen: { url: string; method?: string }[] = [];
  __setMigrationFetchForTest(async (url, init) => {
    seen.push({ url, method: init?.method });
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  await stopResource(cred, "applications", "app-1");
  assert.deepEqual(seen, [
    {
      url: "https://coolify.test/api/v1/applications/app-1/stop",
      method: "POST",
    },
  ]);
});
