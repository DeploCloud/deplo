import { test } from "node:test";
import assert from "node:assert/strict";

import { twinAt } from "./machines";

const rows = [
  { sourceId: "", ipAddress: "coolify.acme.test" },
  { sourceId: "srv-1", ipAddress: "203.0.113.10" },
];

test("a typed address that is another listed machine's is that machine", () => {
  assert.equal(twinAt(rows, "", " 203.0.113.10 ")?.sourceId, "srv-1");
  assert.equal(twinAt(rows, "srv-1", "203.0.113.10"), null, "never itself");
  assert.equal(twinAt(rows, "", "203.0.113.11"), null);
  assert.equal(twinAt(rows, "", "   "), null);
});
