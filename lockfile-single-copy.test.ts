import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const lockfile = () =>
  readFileSync(new URL("./bun.lock", import.meta.url), "utf8");

// Two copies of a CodeMirror package break the editor at runtime, where nothing type-checks
// it for you. This is what replaced the three dedupe overrides once they went stale.
test("the lockfile holds one copy of each CodeMirror package", () => {
  const nested =
    lockfile().match(/"[^"]+\/@codemirror\/(?:state|view|language)"/g) ?? [];
  assert.deepEqual(nested, []);
});

// These two were security pins: next and postcss nested their own flagged copy while their
// ranges already accepted the patched one. The pins went when the tree deduped on its own,
// so a second copy coming back has to turn the repo red instead of going unnoticed.
test("the lockfile holds one copy of sharp and source-map-js", () => {
  const nested = lockfile().match(/"[^"]+\/(?:sharp|source-map-js)"/g) ?? [];
  assert.deepEqual(nested, []);
});
