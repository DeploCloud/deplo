import test from "node:test";
import assert from "node:assert/strict";
import { nextTip } from "./sidebar-tips";

const ctx = { hasSecondFactor: false, capabilities: [], isAdmin: false };

test("the two-factor nudge shows for an account without one", () => {
  assert.equal(nextTip([], ctx)?.id, "two-factor");
});

test("an account with a second factor sees nothing", () => {
  assert.equal(nextTip([], { ...ctx, hasSecondFactor: true }), null);
});

test("a dismissed card never comes back", () => {
  assert.equal(nextTip(["two-factor"], ctx), null);
});
