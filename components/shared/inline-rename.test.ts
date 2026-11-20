import { test } from "node:test";
import assert from "node:assert/strict";

import { renamedTo } from "./inline-rename";

test("renamedTo saves a trimmed new name", () => {
  assert.equal(renamedTo("  api  ", "web"), "api");
});

test("renamedTo keeps the old name for an empty or unchanged draft", () => {
  assert.equal(renamedTo("   ", "web"), null);
  assert.equal(renamedTo(" web ", "web"), null);
});
