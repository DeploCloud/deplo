import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// No DEPLO_DATABASE_URL → the store runs in its test-only in-memory mode (no
// Postgres, no disk). DEPLO_DATA_DIR points build/upload staging at a throwaway
// dir, set BEFORE the store module loads (folders.ts pulls it in transitively).
// The module is imported lazily inside each test because the runner transpiles
// to CJS (no top-level await).
process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-folders-"));
delete process.env.DEPLO_DATABASE_URL;
delete process.env.DATABASE_URL;

test("mergeOrder keeps valid requested ids in order, drops the rest", async () => {
  const { mergeOrder } = await import("./folders");
  // Unknown ("x") and duplicate ("a") ids are dropped; order is honoured.
  assert.deepEqual(
    mergeOrder(["b", "a", "x", "a"], ["a", "b", "c"]),
    ["b", "a", "c"],
    "unknown + duplicate dropped, omitted 'c' appended last",
  );
});

test("mergeOrder appends omitted ids preserving their existing order", async () => {
  const { mergeOrder } = await import("./folders");
  // Client only reordered the first two; c and d must keep their relative order.
  assert.deepEqual(mergeOrder(["b", "a"], ["a", "b", "c", "d"]), [
    "b",
    "a",
    "c",
    "d",
  ]);
});

test("mergeOrder is total and self-healing for empty / fully-stale input", async () => {
  const { mergeOrder } = await import("./folders");
  // No request → the authoritative order is returned verbatim.
  assert.deepEqual(mergeOrder([], ["a", "b"]), ["a", "b"]);
  // Every requested id is unknown → still returns the full authoritative set.
  assert.deepEqual(mergeOrder(["gone", "stale"], ["a", "b"]), ["a", "b"]);
  // Nothing valid anywhere → empty.
  assert.deepEqual(mergeOrder(["x"], []), []);
});

test("cleanName trims and rejects empty / overlong names", async () => {
  const { cleanName } = await import("./folders");
  assert.equal(cleanName("  Clients  "), "Clients");
  assert.throws(() => cleanName("   "), /required/);
  assert.equal(cleanName("a".repeat(60)).length, 60, "60 chars is allowed");
  assert.throws(() => cleanName("a".repeat(61)), /60 characters/);
});

test("descendantFolderIds returns the folder plus its whole subtree", async () => {
  const { descendantFolderIds } = await import("./folders");
  // a → b → c, a → d, and e as a separate root.
  const folders = [
    { id: "a", parentId: null },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "b" },
    { id: "d", parentId: "a" },
    { id: "e", parentId: null },
  ];
  assert.deepEqual([...descendantFolderIds("a", folders)].sort(), [
    "a",
    "b",
    "c",
    "d",
  ]);
  assert.deepEqual([...descendantFolderIds("b", folders)].sort(), ["b", "c"]);
  assert.deepEqual([...descendantFolderIds("e", folders)].sort(), ["e"]);
  // A pre-existing cycle must not hang the walk.
  const cyclic = [
    { id: "x", parentId: "y" },
    { id: "y", parentId: "x" },
  ];
  assert.deepEqual([...descendantFolderIds("x", cyclic)].sort(), ["x", "y"]);
});

test("rollUpAppCounts credits every ancestor with its subtree's services", async () => {
  const { rollUpAppCounts } = await import("./folders");
  // a → b → c, a → d, and e as a separate root.
  const folders = [
    { id: "a", parentId: null },
    { id: "b", parentId: "a" },
    { id: "c", parentId: "b" },
    { id: "d", parentId: "a" },
    { id: "e", parentId: null },
  ];
  const totals = rollUpAppCounts(
    folders,
    new Map([
      ["a", 1],
      ["c", 2],
      ["d", 1],
    ]),
  );
  assert.equal(totals.get("a"), 4, "1 direct + 2 in grandchild c + 1 in child d");
  assert.equal(totals.get("b"), 2, "c's services bubble up through b");
  assert.equal(totals.get("c"), 2);
  assert.equal(totals.get("d"), 1);
  assert.equal(totals.get("e") ?? 0, 0, "a sibling root gets nothing");
});

test("rollUpAppCounts tolerates cycles and dangling parents", async () => {
  const { rollUpAppCounts } = await import("./folders");
  const broken = [
    { id: "x", parentId: "y" },
    { id: "y", parentId: "x" },
    { id: "z", parentId: "ghost" },
  ];
  const totals = rollUpAppCounts(
    broken,
    new Map([
      ["x", 1],
      ["z", 3],
    ]),
  );
  // Each cycle member is credited exactly once — and the walk terminates.
  assert.equal(totals.get("x"), 1);
  assert.equal(totals.get("y"), 1);
  // A dangling parentId just ends the walk (folder treated as top-level).
  assert.equal(totals.get("z"), 3);
});
