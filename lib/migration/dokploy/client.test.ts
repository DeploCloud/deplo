import { test } from "node:test";
import assert from "node:assert/strict";

import { getConvertedCompose, listProjects } from "./client";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
  describeTransportError,
  normalizeSourceBaseUrl,
} from "../transport";

/**
 * The transport half of the import. Both cases here were measured against a real
 * Dokploy: a repo-backed stack answering the JSON body `null`, and the bare
 * "fetch failed" every connection problem used to arrive as.
 */

const cred = {
  kind: "dokploy" as const,
  baseUrl: "http://dokploy.test:3000",
  apiKey: "k",
};

function answers(body: unknown): void {
  __setMigrationFetchForTest(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

test("a compose Dokploy has not resolved yet is nothing, not the string null", async (t) => {
  t.after(__resetMigrationFetchForTest);

  // What the endpoint really answers for a git-backed stack it has not cloned.
  answers(null);
  assert.equal(await getConvertedCompose(cred, "c1"), null);

  // The same body arriving as text, which is how a Dokploy behind a proxy sends it.
  __setMigrationFetchForTest(
    async () => new Response("null\n", { status: 200 }),
  );
  assert.equal(await getConvertedCompose(cred, "c1"), null);

  answers("");
  assert.equal(await getConvertedCompose(cred, "c1"), null);
});

test("a real compose comes through, however Dokploy wraps it", async (t) => {
  t.after(__resetMigrationFetchForTest);

  answers("services:\n  web:\n    image: nginx\n");
  assert.match((await getConvertedCompose(cred, "c1")) ?? "", /^services:/);

  answers({
    compose: "null",
    resolved: "services:\n  web:\n    image: nginx\n",
  });
  assert.match((await getConvertedCompose(cred, "c1")) ?? "", /^services:/);
});

/** The panel every message in these tests is about. */
const DOKPLOY = { name: "Dokploy", portHint: ":3000" };

test("a connection failure says which one it was", () => {
  const withCode = (code: string) =>
    describeTransportError(
      Object.assign(new TypeError("fetch failed"), { cause: { code } }),
      "https://dokploy.test",
      DOKPLOY,
    );

  assert.match(withCode("ECONNREFUSED"), /Nothing is listening/);
  assert.match(withCode("ECONNREFUSED"), /:3000/);
  assert.match(withCode("ENOTFOUND"), /does not resolve/);
  assert.match(withCode("ERR_SSL_WRONG_VERSION_NUMBER"), /not over https/);
  assert.match(withCode("CERT_HAS_EXPIRED"), /certificate/);

  const timeout = describeTransportError(
    Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    }),
    "https://dokploy.test",
    DOKPLOY,
  );
  assert.match(timeout, /did not answer within/);

  // Even an unrecognised one names the address instead of saying "fetch failed".
  assert.match(
    describeTransportError(
      new TypeError("fetch failed"),
      "https://dokploy.test",
      DOKPLOY,
    ),
    /Could not reach Dokploy at https:\/\/dokploy\.test/,
  );
});

test("an https IP with a bad certificate is told it is the wrong field", () => {
  // The trap this exists for: the NEXT step asks for the machine's own address, and a
  // fair number of people come back and put it in the PANEL field.
  const certFail = (baseUrl: string) =>
    describeTransportError(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
      }),
      baseUrl,
      DOKPLOY,
    );

  const onIp = certFail("https://185.58.122.151");
  assert.match(onIp, /issued for the panel's NAME/);
  assert.match(onIp, /asked for at the next step/);

  // A NAME with a bad certificate is a certificate problem and nothing else -
  // saying "wrong field" there would send someone to edit a field that is right.
  const onName = certFail("https://dokploy.acme.com");
  assert.doesNotMatch(onName, /next step/);
  assert.match(onName, /certificate/);

  // http on an IP is the same-machine case the field's own placeholder suggests,
  // so it never gets the lecture.
  assert.doesNotMatch(certFail("http://172.17.0.1:3000"), /next step/);
});

test("a failure raised by the transport reaches the caller readable", async (t) => {
  t.after(__resetMigrationFetchForTest);
  __setMigrationFetchForTest(async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
  });
  await assert.rejects(listProjects(cred), /Nothing is listening/);
  // The compose call still swallows: a stack Dokploy cannot resolve is a report
  // line, never a failed import.
  assert.equal(await getConvertedCompose(cred, "c1"), null);
});

test("the address keeps rejecting a key smuggled into it", () => {
  assert.throws(
    () => normalizeSourceBaseUrl("https://user:pass@dokploy.test"),
    /API key field/,
  );
});
