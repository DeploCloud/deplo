// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  childKey,
  NOTHING_REMOVED,
  retainRemoved,
  withoutRemoved,
} from "./optimistic-remove";

// The rows a table gets from the server, as the hook sees them: keys only.
const serverKeys = (...keys: string[]) => keys;

test("a hidden key survives while the server still serves it", () => {
  const removed = new Set(["standalone:a"]);
  // The refresh has not landed yet - the row is still in the RSC payload.
  const kept = retainRemoved(
    removed,
    serverKeys("standalone:a", "standalone:b"),
  );
  assert.equal(
    kept,
    removed,
    "must return the SAME set - a new one re-renders forever",
  );
});

test("a hidden key retires as soon as the server stops serving it", () => {
  const removed = new Set(["standalone:a"]);
  const kept = retainRemoved(removed, serverKeys("standalone:b"));
  assert.equal(kept.size, 0);
  assert.equal(kept, NOTHING_REMOVED, "empty again means the shared empty set");
});

test("two deletes in flight settle one at a time", () => {
  const removed = new Set(["standalone:a", "standalone:b"]);
  // The first delete's refresh lands; the second one's has not.
  const afterFirst = retainRemoved(
    removed,
    serverKeys("standalone:b", "standalone:c"),
  );
  assert.deepEqual([...afterFirst], ["standalone:b"]);
  // The second lands too.
  const afterSecond = retainRemoved(afterFirst, serverKeys("standalone:c"));
  assert.deepEqual([...afterSecond], []);
});

test("a key that comes back later is not hidden by a stale entry", () => {
  // A shared variable unlinked from an app…
  const hidden = new Set(["shared:v1"]);
  const retired = retainRemoved(hidden, serverKeys("standalone:a"));
  assert.deepEqual([...retired], []);
  // …and re-linked afterwards: the row must show, not inherit the old hide.
  const rows = [{ id: "shared:v1" }, { id: "standalone:a" }];
  assert.deepEqual(
    withoutRemoved(rows, retired, (r) => r.id).map((r) => r.id),
    ["shared:v1", "standalone:a"],
  );
});

test("nothing hidden hands the very same list back", () => {
  const rows = [{ id: "a" }, { id: "b" }];
  assert.equal(
    withoutRemoved(rows, NOTHING_REMOVED, (r) => r.id),
    rows,
    "a fresh copy would invalidate the memos the tables build on it",
  );
});

test("hidden rows drop out of the list, the rest keep their order", () => {
  const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const visible = withoutRemoved(rows, new Set(["b"]), (r) => r.id);
  assert.deepEqual(
    visible.map((r) => r.id),
    ["a", "c"],
  );
});

test("a child's key is matched against the id its row hides", () => {
  // What React.Children.toArray hands back for a bare `list.map(…)`.
  assert.equal(childKey({ key: ".$dom_123" }), "dom_123");
  // …and for the same map rendered NEXT TO a sibling (the placeholder rows),
  // where the map is one nested array among several. Measured, not guessed.
  assert.equal(childKey({ key: ".0:$dom_123" }), "dom_123");
  // A placeholder with no key of its own can never be hidden by an id.
  assert.equal(childKey({ key: null }), "");
  assert.equal(
    childKey({ key: ".1" }),
    ".1",
    "no key of its own, matches no id",
  );
  assert.equal(
    childKey({ key: "dom_123" }),
    "dom_123",
    "already bare, left alone",
  );
});

test("hiding every row leaves an empty list - the table's empty state", () => {
  const rows = [{ id: "a" }, { id: "b" }];
  assert.deepEqual(
    withoutRemoved(rows, new Set(["a", "b"]), (r) => r.id),
    [],
  );
});
