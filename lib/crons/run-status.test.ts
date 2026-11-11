import { test } from "node:test";
import assert from "node:assert/strict";

import { CRON_RUN_STATUS } from "./run-status";

test("every run status has a label, and a run lost with its server says so and points at Run now", () => {
  assert.deepEqual(Object.keys(CRON_RUN_STATUS).sort(), [
    "failed",
    "lost",
    "running",
    "server_lost",
    "skipped",
    "succeeded",
    "timedout",
  ]);
  for (const meta of Object.values(CRON_RUN_STATUS)) assert.ok(meta.label);
  const lost = CRON_RUN_STATUS.server_lost;
  assert.equal(lost.label, "Lost: its server stopped");
  assert.match(lost.note ?? "", /never runs a lost run again on its own/);
  assert.match(lost.note ?? "", /Run now/);
  assert.ok((lost.note ?? "").length <= 200, "a muted paragraph caps at 200");
});
