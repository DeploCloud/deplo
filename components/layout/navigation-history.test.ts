import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { record, backOutOf } from "./navigation-history";

let jumped: number | null = null;
const history = {
  state: null as Record<string, unknown> | null,
  replaceState(s: unknown) {
    history.state = s as Record<string, unknown>;
  },
  go(delta: number) {
    jumped = delta;
  },
};
(globalThis as { window?: unknown }).window = { history };

/** A pushed entry carries no stamp of ours until `record` puts one there. */
function visit(path: string) {
  history.state = null;
  record(path);
}

test("back out of an app jumps past the wizard that created it", () => {
  visit("/");
  visit("/new");
  visit("/apps/foo");
  assert.equal(backOutOf("/apps/foo"), "jumped");
  assert.equal(jumped, -2);
});

test("the wizard's own layout records its entry", () => {
  const layout = readFileSync("app/(focus)/layout.tsx", "utf8");
  assert.match(layout, /<NavigationHistoryTracker \/>/);
});
