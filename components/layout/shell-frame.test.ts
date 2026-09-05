import { test } from "node:test";
import assert from "node:assert/strict";

import { isDottedRoute } from "./shell-frame";

test("the Overview and a database's pages are dotted, nothing else", () => {
  assert.equal(isDottedRoute("/"), true);
  assert.equal(isDottedRoute("/storage/databases/db_1"), true);
  assert.equal(
    isDottedRoute("/storage/databases/db_1/settings/connection"),
    true,
  );
  assert.equal(isDottedRoute("/storage"), false);
  assert.equal(isDottedRoute("/apps/web"), false);
  assert.equal(isDottedRoute("/logs"), false);
});
