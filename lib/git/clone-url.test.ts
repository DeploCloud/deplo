import { test } from "node:test";
import assert from "node:assert/strict";

import { forkCloneUrl, redactCloneUrl } from "./clone-url";

/**
 * What a fork preview is allowed to clone.
 */

const BASE = "https://github.com/acme/app.git";

test("a fork on the same host is cloned from its own address", () => {
  assert.equal(
    forkCloneUrl(BASE, "https://github.com/stranger/app.git"),
    "https://github.com/stranger/app.git",
  );
});

test("a query string or fragment cannot ride along", () => {
  assert.equal(
    forkCloneUrl(BASE, "https://github.com/stranger/app.git?x=1#y"),
    "https://github.com/stranger/app.git",
  );
});

test("another host is refused - a payload must not redirect the clone", () => {
  assert.throws(
    () => forkCloneUrl(BASE, "https://evil.test/stranger/app.git"),
    /hosted on evil.test/,
  );
});

test("plain http is refused", () => {
  assert.throws(
    () => forkCloneUrl(BASE, "http://github.com/stranger/app.git"),
    /not https/,
  );
});

test("an scp-style remote is refused - it has nowhere to state a host", () => {
  assert.throws(
    () => forkCloneUrl(BASE, "git@github.com:stranger/app.git"),
    /is not a URL/,
  );
});

test("an address carrying a credential is refused", () => {
  assert.throws(
    () => forkCloneUrl(BASE, "https://user:pw@github.com/stranger/app.git"),
    /carries a credential/,
  );
});

test("a row with no recorded address refuses instead of building the base repo", () => {
  assert.throws(() => forkCloneUrl(BASE, ""), /no clone address was recorded/);
});

test("the returned address never carries a credential of ours", () => {
  const url = forkCloneUrl(BASE, "https://github.com/stranger/app.git");
  assert.equal(redactCloneUrl(url), url);
});
