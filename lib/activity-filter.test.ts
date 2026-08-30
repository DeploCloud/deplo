// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EMPTY_ACTIVITY_PARAMS,
  activityCountWindow,
  activityCountWindowLabel,
  type ActivityParams,
} from "./activity-filter";

/** `activities` has no retention, so the rail's window is never left open. */

const NOW = Date.parse("2026-08-31T00:00:00.000Z");
const params = (p: Partial<ActivityParams>): ActivityParams => ({
  ...EMPTY_ACTIVITY_PARAMS,
  ...p,
});

test("no dates picked: the counts fall back to 30 days", () => {
  assert.deepEqual(activityCountWindow(EMPTY_ACTIVITY_PARAMS, NOW), {
    from: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(activityCountWindowLabel(EMPTY_ACTIVITY_PARAMS), "Last 30 days");
});

test("a picked range wins, and says its own name", () => {
  const p = params({ range: "7d" });
  assert.deepEqual(activityCountWindow(p, NOW), {
    from: "2026-08-24T00:00:00.000Z",
  });
  assert.equal(activityCountWindowLabel(p), "Last 7 days");
});

test("a custom range wins even when only one end is set", () => {
  const both = params({ from: "2026-08-01", to: "2026-08-15" });
  assert.deepEqual(activityCountWindow(both, NOW), {
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-16T00:00:00.000Z",
  });
  assert.equal(activityCountWindowLabel(both), "1 Aug - 15 Aug");

  const until = params({ to: "2026-08-15" });
  assert.deepEqual(activityCountWindow(until, NOW), {
    from: undefined,
    to: "2026-08-16T00:00:00.000Z",
  });
  assert.equal(activityCountWindowLabel(until), "Until 15 Aug");
  assert.equal(
    activityCountWindowLabel(params({ from: "2026-08-01" })),
    "Since 1 Aug",
  );
});
