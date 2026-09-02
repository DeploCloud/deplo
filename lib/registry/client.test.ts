import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { checkRegistryCredential } from "./client";

/**
 * The credential check: a token registry's realm decides, a Basic-only one
 * decides on the probe, and an unreachable host decides nothing.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** A public IP literal skips DNS, so the SSRF guard needs no network. */
const HOST = "1.1.1.1";
const CHALLENGE = 'Bearer realm="https://1.1.1.1/token",service="reg"';

function stub(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const seen: { url: string; init?: RequestInit }[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return seen;
}

const check = () => checkRegistryCredential(HOST, "octocat", "ghp_token");

test("an open registry answers the probe itself", async () => {
  stub(() => new Response("{}", { status: 200 }));
  assert.equal(await check(), "ok");
});

test("the realm issuing a token means the credential works", async () => {
  const seen = stub((url) =>
    url.endsWith("/v2/")
      ? new Response(null, {
          status: 401,
          headers: { "www-authenticate": CHALLENGE },
        })
      : new Response(JSON.stringify({ token: "t" }), { status: 200 }),
  );
  assert.equal(await check(), "ok");
  assert.match(seen[1]!.url, /account=octocat/);
  assert.equal(
    (seen[0]!.init!.headers as Record<string, string>).Authorization,
    `Basic ${Buffer.from("octocat:ghp_token").toString("base64")}`,
  );
});

// ghcr answers a dead token 403, the Hub and GitLab 401 - both are a refusal.
for (const status of [401, 403]) {
  test(`the realm answering ${status} rejects the credential`, async () => {
    stub((url) =>
      url.endsWith("/v2/")
        ? new Response(null, {
            status: 401,
            headers: { "www-authenticate": CHALLENGE },
          })
        : new Response(null, { status }),
    );
    assert.equal(await check(), "rejected");
  });
}

test("a Basic-only registry rejects on the probe", async () => {
  stub(() => new Response(null, { status: 401 }));
  assert.equal(await check(), "rejected");
});

test("a realm that is down decides nothing", async () => {
  stub((url) =>
    url.endsWith("/v2/")
      ? new Response(null, {
          status: 401,
          headers: { "www-authenticate": CHALLENGE },
        })
      : new Response(null, { status: 503 }),
  );
  assert.equal(await check(), "unknown");
});

test("an unreachable registry decides nothing", async () => {
  stub(() => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal(await check(), "unknown");
});

test("a private host is never probed", async () => {
  const seen = stub(() => new Response(null, { status: 200 }));
  assert.equal(await checkRegistryCredential("127.0.0.1", "u", "p"), "unknown");
  assert.equal(seen.length, 0);
});
