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
  const layout = readFileSync("app/(focus)/[team]/layout.tsx", "utf8");
  assert.match(layout, /<NavigationHistoryTracker \/>/);
});

test("with the browser's own entry list, a same-URL entry no longer stops the jump short", async () => {
  const at = (path: string) => ({ url: `http://localhost${path}` });
  const win = globalThis as { window: { navigation?: unknown } };
  win.window.navigation = {
    currentEntry: { index: 4 },
    entries: () => [
      at("/acme"),
      at("/acme/apps/web"),
      at("/acme/apps/web/environment"),
      at("/acme/apps/web/environment"),
      at("/acme/apps/web/logs"),
    ],
  };
  await new Promise((r) => setTimeout(r, 1100));
  try {
    assert.equal(backOutOf("/apps/web"), "jumped");
    assert.equal(jumped, -4);
  } finally {
    delete win.window.navigation;
  }
});

test("nothing outside the section in the entry list leaves the link to navigate", async () => {
  const win = globalThis as { window: { navigation?: unknown } };
  win.window.navigation = {
    currentEntry: { index: 1 },
    entries: () => [
      { url: "http://localhost/acme/apps/web" },
      { url: "http://localhost/acme/apps/web/logs" },
    ],
  };
  await new Promise((r) => setTimeout(r, 1100));
  try {
    assert.equal(backOutOf("/apps/web"), "none");
  } finally {
    delete win.window.navigation;
  }
});
