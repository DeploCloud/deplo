import { test } from "node:test";
import assert from "node:assert/strict";

import { visiblePendingChanges } from "./pending-changes";

const CHANGED = "2026-10-02T10:00:00.000Z";
const BEFORE = "2026-10-02T09:59:00.000Z";
const AFTER = "2026-10-02T10:01:00.000Z";

test("a deploy queued after the change hides the notice", () => {
  for (const status of ["queued", "building"] as const)
    assert.equal(
      visiblePendingChanges({
        pendingChangesAt: CHANGED,
        latestDeployment: { status, createdAt: AFTER },
      }),
      null,
    );
});

test("a deploy that started before the change keeps the notice", () => {
  assert.equal(
    visiblePendingChanges({
      pendingChangesAt: CHANGED,
      latestDeployment: { status: "building", createdAt: BEFORE },
    }),
    CHANGED,
  );
});

test("a failed deploy brings the notice back", () => {
  assert.equal(
    visiblePendingChanges({
      pendingChangesAt: CHANGED,
      latestDeployment: { status: "error", createdAt: AFTER },
    }),
    CHANGED,
  );
});

test("no change, no notice", () => {
  assert.equal(
    visiblePendingChanges({
      pendingChangesAt: null,
      latestDeployment: { status: "queued", createdAt: AFTER },
    }),
    null,
  );
});
