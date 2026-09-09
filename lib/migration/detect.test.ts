import { test } from "node:test";
import assert from "node:assert/strict";

import { detectMigrationSource } from "./detect";
import { SELF_PANEL_REFUSAL } from "./self";
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

test("Cloudflare's 521 stops the detection instead of quoting its page", async (t) => {
  // The address is proxied whatever runs behind it, so a 52x is the PROXY talking:
  // one sentence, and the second guess is never tried (it would answer the same).
  reset(t);
  const seen: string[] = [];
  __setMigrationFetchForTest(async (url) => {
    seen.push(url);
    return new Response(
      JSON.stringify({ title: "Error 521: Web server is down" }),
      { status: 521, headers: { "cf-ray": "8f0b2c1d9e00-FRA" } },
    );
  });
  await assert.rejects(detectMigrationSource(BASE, DOKPLOY_KEY), (e: Error) => {
    assert.equal(e.name, "PanelUnreachableError");
    assert.match(e.message, /Cloudflare answered for panel\.test/);
    assert.match(e.message, /nothing is running behind it \(521\)/);
    assert.doesNotMatch(e.message, /Error 521: Web server is down/);
    return true;
  });
  assert.equal(seen.length, 1, "the other platform is never tried");
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
    // One sentence, then a log: the wizard shows the first line and puts the
    // rest behind View logs.
    const [headline, ...log] = e.message.split("\n");
    assert.match(headline, /^Deplo could not read https:\/\/panel\.test/);
    assert.doesNotMatch(headline, /request failed|refused/);
    assert.deepEqual(
      log.map((l) => l.split(" check: ")[0]),
      ["Dokploy", "Coolify"],
    );
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

// Deplo's own health is `{"ok":true}`, which is Dokploy's word for word: read by
// that alone, somebody's own panel came back "a Dokploy that refused the token".
test("Deplo's own address is named as Deplo, not as a Dokploy", async (t) => {
  reset(t);
  __setMigrationFetchForTest(async (url) => {
    if (url.endsWith("/api/health"))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (url.endsWith("/api/graphql"))
      return new Response(
        JSON.stringify({ errors: [{ message: "Must provide query string." }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    return new Response("<!doctype html><html></html>", { status: 404 });
  });
  await assert.rejects(detectMigrationSource(BASE, DOKPLOY_KEY), (e: Error) => {
    assert.equal(e.message, SELF_PANEL_REFUSAL);
    return true;
  });
});

test("a Dokploy that refuses the token is still a Dokploy", async (t) => {
  reset(t);
  const seen: string[] = [];
  __setMigrationFetchForTest(async (url) => {
    seen.push(url);
    if (url.endsWith("/api/health"))
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    return new Response(JSON.stringify({ message: "Unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  });
  await assert.rejects(
    detectMigrationSource(BASE, DOKPLOY_KEY),
    /That is a Dokploy panel/,
  );
  // Asked, and it answered nothing yoga would: the Deplo probe decides nothing here.
  assert.ok(seen.some((u) => u.endsWith("/api/graphql")));
});
