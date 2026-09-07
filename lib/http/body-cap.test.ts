import { test } from "node:test";
import assert from "node:assert/strict";

import { capRequestBody, readTextCapped } from "./body-cap";

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request("http://x/hook", { method: "POST", body, headers });

test("a declared oversize body is refused before it is read", async () => {
  const res = capRequestBody(post("x", { "content-length": "9999999" }), 1024);
  assert.ok(res instanceof Response);
  assert.equal(res.status, 413);
});

test("an undeclared body is cut off at the cap, a small one passes", async () => {
  const big = await readTextCapped(post("a".repeat(2048)), 1024);
  assert.ok(big instanceof Response);
  assert.equal(big.status, 413);
  const small = await readTextCapped(post("hello"), 1024);
  assert.equal(small, "hello");
});
