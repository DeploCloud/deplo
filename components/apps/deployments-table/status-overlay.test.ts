import { test } from "node:test";
import assert from "node:assert/strict";

import { withLiveStatus } from "./status-overlay";

test("keeps only ids on screen plus the one just reported", () => {
  const prev = new Map([
    ["gone", "building"],
    ["kept", "queued"],
  ]);
  const next = withLiveStatus(prev, "new", "building", new Set(["kept"]));
  assert.deepEqual(
    [...next],
    [
      ["kept", "queued"],
      ["new", "building"],
    ],
  );
});

test("an unchanged status returns the same map", () => {
  const prev = new Map([["a", "ready"]]);
  assert.equal(withLiveStatus(prev, "a", "ready", new Set()), prev);
});
