import { test } from "node:test";
import assert from "node:assert/strict";

import { detectMigrationSource } from "./detect";
import { __resetCoolifyRateLimitForTest } from "./coolify/client";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "./transport";

/**
 * Which panel is answering. The order is an optimisation; the ANSWER is always
 * the call that succeeded, never the guess.
 */

const DOKPLOY_KEY = "dok_1a2b3c4d5e6f7g8h";
const COOLIFY_TOKEN = "3|abcdefghijklmnopqrstuvwxyz012345";
const BASE = "https://panel.test";

function reset(t: { after: (fn: () => void) => void }): void {
  t.after(__resetMigrationFetchForTest);
  t.after(__resetCoolifyRateLimitForTest);
}

/** Answers 200 to whichever path matches, 401 to everything else. */
function only(match: string, body: unknown = []): string[] {
  const seen: string[] = [];
  __setMigrationFetchForTest(async (url) => {
    seen.push(url);
    if (url.includes(match))
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return new Response(JSON.stringify({ message: "Unauthenticated." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  });
  return seen;
}

test("a Dokploy answers as a Dokploy", async (t) => {
  reset(t);
  const seen = only("/api/project.all");
  assert.equal(await detectMigrationSource(BASE, DOKPLOY_KEY), "dokploy");
  assert.equal(seen.length, 1);
});

test("a Coolify answers as a Coolify", async (t) => {
  reset(t);
  const seen = only("/api/v1/projects");
  assert.equal(await detectMigrationSource(BASE, COOLIFY_TOKEN), "coolify");
  // Sanctum's `<id>|<random>` put Coolify first, so one call was enough.
  assert.equal(seen.length, 1);
});

test("the token's shape only chooses the order, never the answer", async (t) => {
  reset(t);
  // A Coolify whose token does not look like one: Dokploy is asked first, refuses,
  // and Coolify still wins.
  const seen = only("/api/v1/projects");
  assert.equal(await detectMigrationSource(BASE, DOKPLOY_KEY), "coolify");
  assert.equal(seen.length, 2);
  assert.ok(seen[0].includes("/api/project.all"));
});

// Two timeouts are thirty seconds of spinner for an address that answered
// neither time. This is the assertion that pins it.
test("a machine that does not answer is asked exactly once", async (t) => {
  reset(t);
  let calls = 0;
  __setMigrationFetchForTest(async () => {
    calls += 1;
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
  });
  await assert.rejects(
    detectMigrationSource(BASE, DOKPLOY_KEY),
    /Nothing is listening/,
  );
  assert.equal(calls, 1);
});

test("both refusing names both refusals", async (t) => {
  reset(t);
  __setMigrationFetchForTest(
    async (url) =>
      new Response(
        JSON.stringify({
          message: url.includes("v1") ? "Invalid token." : "no",
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
  );
  await assert.rejects(detectMigrationSource(BASE, DOKPLOY_KEY), (e: Error) => {
    assert.match(e.message, /could not read https:\/\/panel\.test/);
    assert.match(e.message, /Coolify:/);
    assert.match(e.message, /Dokploy:/);
    return true;
  });
});

test("a Coolify that refuses the token is named as one", async (t) => {
  reset(t);
  __setMigrationFetchForTest(async (url) => {
    // The unauthenticated healthcheck, which only chooses the words.
    if (url.endsWith("/api/health")) return new Response("OK", { status: 200 });
    return new Response(JSON.stringify({ message: "API is disabled." }), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  });
  await assert.rejects(
    detectMigrationSource(BASE, COOLIFY_TOKEN),
    (e: Error) => {
      assert.match(e.message, /That is a Coolify panel/);
      assert.match(e.message, /API is turned off/);
      return true;
    },
  );
});

// A reverse proxy can answer 200 on /api/health. The probe chooses words, so a
// front page must not turn a mystery into a confident wrong answer.
test("somebody's front page on /api/health decides nothing", async (t) => {
  reset(t);
  __setMigrationFetchForTest(async (url) => {
    if (url.endsWith("/api/health"))
      return new Response("<!doctype html><html></html>", { status: 200 });
    return new Response(JSON.stringify({ message: "Unauthenticated." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  });
  await assert.rejects(
    detectMigrationSource(BASE, COOLIFY_TOKEN),
    /could not read/,
  );
});
