import { test } from "node:test";
import assert from "node:assert/strict";

import { soleEnvironmentUsing } from "./network-migration";

test("one Environment uses it: that is where it goes", () => {
  assert.equal(soleEnvironmentUsing(new Set(["environ_a"])), "environ_a");
});

test("nobody names it, or two Environments do: it stays put", () => {
  assert.equal(soleEnvironmentUsing(new Set()), null);
  assert.equal(soleEnvironmentUsing(new Set(["environ_a", "environ_b"])), null);
});

test("an app at the TEAM'S TOP LEVEL counts, and stops the move", () => {
  assert.equal(soleEnvironmentUsing(new Set(["environ_a", ""])), null);
  assert.equal(soleEnvironmentUsing(new Set([""])), null);
});
