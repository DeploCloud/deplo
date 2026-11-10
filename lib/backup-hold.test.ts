import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { heldLabel } from "./backup-hold";

describe("heldLabel", () => {
  it("says nothing when the App was not paused", () => {
    assert.equal(heldLabel(null), null);
    assert.equal(heldLabel(undefined), null);
    assert.equal(heldLabel(0), null);
  });
  it("reads in seconds, then minutes", () => {
    assert.equal(heldLabel(400), "App paused under 1 s");
    assert.equal(heldLabel(2140), "App paused 2.1 s");
    assert.equal(heldLabel(64_000), "App paused 1 min 4 s");
  });
});
