// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";
import { isRefusal } from "./repo-access";

test("only an explicit refusal blocks a deploy - everything else fails open", () => {
  // A real answer about this repository: the App cannot see it.
  assert.equal(isRefusal(new Error("GitHub repo check failed (404)")), true);
  assert.equal(isRefusal(new Error("GitHub repo check failed (403)")), true);
  assert.equal(isRefusal(new Error("GitHub repo check failed (401)")), true);
  // The other three providers spell the status the same way.
  assert.equal(
    isRefusal(new Error("GitLab request failed (403): insufficient scope")),
    true,
  );
  assert.equal(
    isRefusal(new Error("Gitea request failed (404): not found")),
    true,
  );

  // A bad minute at the provider must NEVER fail a deploy that would have
  // worked: this check explains a failure, it must not invent one.
  assert.equal(isRefusal(new Error("GitHub repo check failed (429)")), false);
  assert.equal(isRefusal(new Error("GitHub repo check failed (500)")), false);
  assert.equal(isRefusal(new Error("GitHub repo check failed (502)")), false);
  assert.equal(
    isRefusal(new Error("Could not mint GitHub installation token (500)")),
    false,
  );
  // No status to read at all.
  assert.equal(isRefusal(new Error("GitHub installation not found")), false);
  assert.equal(isRefusal(new Error("fetch failed")), false);
  assert.equal(isRefusal(new DOMException("timed out", "TimeoutError")), false);
  assert.equal(isRefusal(undefined), false);
  assert.equal(isRefusal(null), false);
});
