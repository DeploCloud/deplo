import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { isPasswordPwned } from "./pwned-password";

const PASSWORD = "Str0ng!pass";
const SHA1 = createHash("sha1")
  .update(PASSWORD, "utf8")
  .digest("hex")
  .toUpperCase();
const PREFIX = SHA1.slice(0, 5);
const SUFFIX = SHA1.slice(5);

/** Swap `fetch`, run, put it back — the module reads the global on every call. */
async function withFetch(
  impl: (url: string) => Promise<Response> | Response,
  run: () => Promise<void>,
): Promise<void> {
  const real = globalThis.fetch;
  globalThis.fetch = ((url: string) => impl(String(url))) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
}

const body = (text: string) => new Response(text, { status: 200 });

test("isPasswordPwned: a listed suffix is a hit, and only the prefix is sent", async () => {
  let asked = "";
  await withFetch(
    (url) => {
      asked = url;
      return body(`0000000000000000000000000000000000A:2\n${SUFFIX}:12345\n`);
    },
    async () => {
      assert.equal(await isPasswordPwned(PASSWORD), true);
    },
  );
  assert.equal(asked, `https://api.pwnedpasswords.com/range/${PREFIX}`);
  assert.ok(!asked.includes(SUFFIX), "the full hash must never leave the box");
});

test("isPasswordPwned: an unlisted suffix is a miss", async () => {
  await withFetch(
    () =>
      body(
        "0000000000000000000000000000000000A:2\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:9\n",
      ),
    async () => {
      assert.equal(await isPasswordPwned(PASSWORD), false);
    },
  );
});

test("isPasswordPwned: an Add-Padding decoy (count 0) is not a hit", async () => {
  await withFetch(
    () => body(`${SUFFIX}:0\r\n`),
    async () => {
      assert.equal(await isPasswordPwned(PASSWORD), false);
    },
  );
});

test("isPasswordPwned: fails OPEN — offline or a bad status never refuses", async () => {
  await withFetch(
    () => {
      throw new Error("getaddrinfo ENOTFOUND api.pwnedpasswords.com");
    },
    async () => {
      assert.equal(await isPasswordPwned(PASSWORD), false);
    },
  );
  await withFetch(
    () => new Response("rate limited", { status: 429 }),
    async () => {
      assert.equal(await isPasswordPwned(PASSWORD), false);
    },
  );
});

test("isPasswordPwned: an empty password never dials out", async () => {
  await withFetch(
    () => assert.fail("must not fetch"),
    async () => {
      assert.equal(await isPasswordPwned(""), false);
    },
  );
});
