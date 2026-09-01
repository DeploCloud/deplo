import { test } from "node:test";
import assert from "node:assert/strict";

import {
  nextRecents,
  readRecents,
  type Recent,
} from "@/components/command-palette/use-recents";

const row = (id: string, label = id): Recent => ({
  id,
  label,
  href: `/${id}`,
});

/** A localStorage that behaves, for the happy path. */
function withStorage(store: Record<string, string> | null) {
  const g = globalThis as { window?: unknown };
  const before = g.window;
  g.window = {
    localStorage: {
      getItem: (k: string) => {
        if (store === null) throw new Error("storage is blocked");
        return store[k] ?? null;
      },
    },
  };
  return () => {
    g.window = before;
  };
}

test("the newest wins, the list is capped, and an id never repeats", () => {
  let list: Recent[] = [];
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) {
    list = nextRecents(list, row(id));
  }
  assert.deepEqual(
    list.map((r) => r.id),
    ["g", "f", "e", "d", "c"],
    "five, newest first",
  );

  // Choosing something already in there moves it up rather than doubling it.
  list = nextRecents(list, row("d"));
  assert.deepEqual(
    list.map((r) => r.id),
    ["d", "g", "f", "e", "c"],
  );
});

test("a renamed row is remembered under its new label", () => {
  const list = nextRecents(
    [row("app:1", "old name")],
    row("app:1", "new name"),
  );
  assert.deepEqual(
    list.map((r) => r.label),
    ["new name"],
  );
});

test("reading survives everything a browser can hand back", () => {
  const cases: [string, string, number][] = [
    ["nothing stored", "", 0],
    ["not json", "{oops", 0],
    ["json, but not a list", '{"a":1}', 0],
    ["a list of junk", '[1,"two",null]', 0],
    ["rows missing fields", '[{"id":"a"},{"label":"b"}]', 0],
    [
      "one good row among junk",
      '[{"id":"a","label":"A","href":"/a","kind":"nav"},7]',
      1,
    ],
  ];
  for (const [what, raw, expected] of cases) {
    const restore = withStorage(raw ? { k: raw } : {});
    try {
      assert.equal(readRecents("k").length, expected, what);
    } finally {
      restore();
    }
  }
});

test("a browser with storage blocked simply has no history", () => {
  const restore = withStorage(null);
  try {
    assert.deepEqual(readRecents("k"), []);
  } finally {
    restore();
  }
});

test("more than the cap in storage is still capped on the way in", () => {
  const many = Array.from({ length: 40 }, (_, i) => row(`r${i}`));
  const restore = withStorage({ k: JSON.stringify(many) });
  try {
    assert.equal(readRecents("k").length, 5);
  } finally {
    restore();
  }
});
