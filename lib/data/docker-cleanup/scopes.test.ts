import { test } from "node:test";
import assert from "node:assert/strict";
import { CleanupScope } from "../../agent/gen/agent";
import { toRunItems } from "./scopes";

test("legacy BuildKit results remain visible and combine with orphan volumes", () => {
  const result = toRunItems([
    {
      scope: CleanupScope.CLEANUP_SCOPE_ORPHAN_BUILDKIT_CACHE,
      reclaimedBytes: 200,
      itemsRemoved: 2,
      skipped: false,
      error: "",
      items: [],
    },
    {
      scope: CleanupScope.CLEANUP_SCOPE_ORPHAN_VOLUMES,
      reclaimedBytes: 300,
      itemsRemoved: 3,
      skipped: false,
      error: "",
      items: [],
    },
  ]);
  assert.deepEqual(result, [
    {
      scope: "orphan_volumes",
      reclaimedBytes: 500,
      itemsRemoved: 5,
      skipped: false,
      error: null,
    },
  ]);
});
