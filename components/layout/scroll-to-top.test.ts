import { test } from "node:test";
import assert from "node:assert/strict";

import { placeKey } from "./scroll-to-top";

const key = (path: string, query = "") =>
  placeKey(path, new URLSearchParams(query));

test("a new page or an Overview drill-in is a new place, so it opens at the top", () => {
  assert.notEqual(key("/acme"), key("/acme/deployments"));
  assert.notEqual(key("/acme"), key("/acme", "folder=f1"));
  assert.notEqual(
    key("/acme", "project=p1"),
    key("/acme", "project=p1&env=e2"),
  );
});

test("a search, a filter or the grid/list toggle keeps the scroll where it is", () => {
  assert.equal(key("/acme"), key("/acme", "q=api"));
  assert.equal(key("/acme", "folder=f1"), key("/acme", "folder=f1&view=list"));
  assert.equal(
    key("/acme/deployments"),
    key("/acme/deployments", "status=failed"),
  );
});
