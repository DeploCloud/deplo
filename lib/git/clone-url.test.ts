import { test } from "node:test";
import assert from "node:assert/strict";

import {
  assertCloneTargetSafe,
  forkCloneUrl,
  redactCloneUrl,
} from "./clone-url";

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

test("a bare repository address is an outbound address, and never carries a token", async () => {
  // A credential in the address would be stored and shown as typed.
  await assert.rejects(
    () => assertCloneTargetSafe("https://user:tok@github.com/o/r.git"),
    /token in a git connection/,
  );
  await assert.rejects(
    () =>
      assertCloneTargetSafe("https://user:tok@github.com/o/r.git", {
        allowPrivate: true,
      }),
    /token in a git connection/,
    "an admin is not exempt from that one",
  );
  // The fleet's own addresses are not a repository host.
  await assert.rejects(
    () => assertCloneTargetSafe("https://10.0.0.5/o/r.git"),
    /private or internal/,
  );
  await assert.rejects(
    () => assertCloneTargetSafe("git@10.0.0.5:o/r.git"),
    /private or internal/,
  );
  await assert.rejects(
    () => assertCloneTargetSafe("ssh://git@[::1]/o/r.git"),
    /private or internal/,
  );
  await assertCloneTargetSafe("https://10.0.0.5/o/r.git", {
    allowPrivate: true,
  });
  await assertCloneTargetSafe("https://8.8.8.8/o/r.git");
  await assertCloneTargetSafe("git@8.8.8.8:o/r.git");
});
