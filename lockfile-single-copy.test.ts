import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Two copies of a CodeMirror package break the editor at runtime, where nothing type-checks
// it for you. This is what replaced the three dedupe overrides once they went stale.
test("the lockfile holds one copy of each CodeMirror package", () => {
  const lock = readFileSync(new URL("./bun.lock", import.meta.url), "utf8");
  const nested =
    lock.match(/"[^"]+\/@codemirror\/(?:state|view|language)"/g) ?? [];
  assert.deepEqual(nested, []);
});
