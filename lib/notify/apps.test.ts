import { test } from "node:test";
import assert from "node:assert/strict";

import { pruneAlerted } from "./apps";

test("an alerted app its server stopped reporting is forgotten, others are kept", () => {
  const alerted = new Map([
    ["prj_deleted", "srv_a"],
    ["prj_crashing", "srv_a"],
    ["prj_elsewhere", "srv_b"],
  ]);
  pruneAlerted(alerted, "srv_a", new Set(["prj_crashing", "prj_fine"]));
  assert.deepEqual([...alerted.keys()].sort(), [
    "prj_crashing",
    "prj_elsewhere",
  ]);
});
