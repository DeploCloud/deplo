import { test } from "node:test";
import assert from "node:assert/strict";

import { schema } from "./schema";

// c40: the page showed a queued backup's place, the API none, so nobody outside the page could see the line.
test("a backup run says its place in line through the API, as on its page", () => {
  const run = schema.getType("BackupRun") as {
    getFields(): Record<string, { type: { toString(): string } }>;
  };
  assert.equal(run.getFields().queued?.type.toString(), "String");
});
