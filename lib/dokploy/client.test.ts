import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __resetDokployFetchForTest,
  __setDokployFetchForTest,
  describeDokployTransportError,
  getConvertedCompose,
  listProjects,
  normalizeDokployBaseUrl,
} from "./client";

/**
 * The transport half of the import. Both cases here were measured against a real
 * Dokploy: a repo-backed stack answering the JSON body `null`, and the bare
 * "fetch failed" every connection problem used to arrive as.
 */

const cred = { baseUrl: "http://dokploy.test:3000", apiKey: "k" };

function answers(body: unknown): void {
  __setDokployFetchForTest(async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
}

test("a compose Dokploy has not resolved yet is nothing, not the string null", async (t) => {
  t.after(__resetDokployFetchForTest);

  // What the endpoint really answers for a git-backed stack it has not cloned.
  answers(null);
  assert.equal(await getConvertedCompose(cred, "c1"), null);

  // The same body arriving as text, which is how a Dokploy behind a proxy sends it.
  __setDokployFetchForTest(async () => new Response("null\n", { status: 200 }));
  assert.equal(await getConvertedCompose(cred, "c1"), null);

  answers("");
  assert.equal(await getConvertedCompose(cred, "c1"), null);
});

test("a real compose comes through, however Dokploy wraps it", async (t) => {
  t.after(__resetDokployFetchForTest);

  answers("services:\n  web:\n    image: nginx\n");
  assert.match((await getConvertedCompose(cred, "c1")) ?? "", /^services:/);

  answers({ compose: "null", resolved: "services:\n  web:\n    image: nginx\n" });
  assert.match((await getConvertedCompose(cred, "c1")) ?? "", /^services:/);
});

test("a connection failure says which one it was", () => {
  const withCode = (code: string) =>
    describeDokployTransportError(
      Object.assign(new TypeError("fetch failed"), { cause: { code } }),
      "https://dokploy.test",
    );

  assert.match(withCode("ECONNREFUSED"), /Nothing is listening/);
  assert.match(withCode("ECONNREFUSED"), /:3000/);
  assert.match(withCode("ENOTFOUND"), /does not resolve/);
  assert.match(withCode("ERR_SSL_WRONG_VERSION_NUMBER"), /not over https/);
  assert.match(withCode("CERT_HAS_EXPIRED"), /certificate/);

  const timeout = describeDokployTransportError(
    Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }),
    "https://dokploy.test",
  );
  assert.match(timeout, /did not answer within/);

  // Even an unrecognised one names the address instead of saying "fetch failed".
  assert.match(
    describeDokployTransportError(new TypeError("fetch failed"), "https://dokploy.test"),
    /Could not reach Dokploy at https:\/\/dokploy\.test/,
  );
});

test("a failure raised by the transport reaches the caller readable", async (t) => {
  t.after(__resetDokployFetchForTest);
  __setDokployFetchForTest(async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  });
  await assert.rejects(listProjects(cred), /Nothing is listening/);
  // The compose call still swallows: a stack Dokploy cannot resolve is a report
  // line, never a failed import.
  assert.equal(await getConvertedCompose(cred, "c1"), null);
});

test("the address keeps rejecting a key smuggled into it", () => {
  assert.throws(() => normalizeDokployBaseUrl("https://user:pass@dokploy.test"), /API key field/);
});
