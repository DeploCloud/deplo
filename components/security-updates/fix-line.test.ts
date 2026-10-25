import { test } from "node:test";
import assert from "node:assert/strict";

import { fixLine } from "./fix-line";

test("fixLine: one plain line per way of getting the fix", () => {
  const base = {
    packageName: "minimist",
    fixedVersion: "1.2.6",
    newerTag: null,
  };
  assert.equal(
    fixLine({ ...base, fix: "code" }),
    "Update minimist to 1.2.6 in your code",
  );
  assert.equal(
    fixLine({ ...base, fix: "deplo" }),
    "Deplo will fix this in an update",
  );
  assert.equal(
    fixLine({ ...base, fix: "newer_tag", newerTag: "1.60.2" }),
    "Version 1.60.2 is available and may fix it",
  );
  assert.equal(
    fixLine({ ...base, fix: "none", fixedVersion: null }),
    "No fix has been published yet",
  );
});
