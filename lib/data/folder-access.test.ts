import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same in-memory harness as folders.test.ts: no DEPLO_DATABASE_URL → the store
// runs in its test-only in-memory mode. We only exercise the PURE capability-
// bounding helpers here (boundedBy / withView), which is where the escalation
// math lives; the DB-touching authorization paths are integration-level and not
// covered by this no-Postgres runner. Imports are lazy (runner transpiles to CJS).
process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-folder-access-"));
delete process.env.DEPLO_DATABASE_URL;
delete process.env.DATABASE_URL;

test("boundedBy intersects and returns canonical capability order", async () => {
  const { boundedBy } = await import("./folder-access");
  // Requested caps are clamped to the bound; order follows ALL_CAPABILITIES,
  // not the input order, and duplicates collapse.
  assert.deepEqual(
    boundedBy(["deploy", "manage_infra", "view"], ["view", "deploy"]),
    ["view", "deploy"],
    "manage_infra dropped (out of bound); canonical order",
  );
  assert.deepEqual(
    boundedBy(["manage_env", "deploy"], ["deploy", "manage_env", "view"]),
    ["deploy", "manage_env"],
    "canonical order regardless of input order",
  );
});

test("boundedBy is empty when nothing overlaps", async () => {
  const { boundedBy } = await import("./folder-access");
  assert.deepEqual(boundedBy(["manage_infra"], ["view", "deploy"]), []);
  assert.deepEqual(boundedBy([], ["view", "deploy"]), []);
  assert.deepEqual(boundedBy(["deploy"], []), []);
});

test("withView always includes view, in canonical order", async () => {
  const { withView } = await import("./folder-access");
  assert.deepEqual(withView([]), ["view"], "bare access still reads view");
  assert.deepEqual(
    withView(["deploy"]),
    ["view", "deploy"],
    "view is prepended in canonical order",
  );
  assert.deepEqual(
    withView(["deploy", "view"]),
    ["view", "deploy"],
    "no duplicate view",
  );
});

test("a granter can never hand out a capability they lack (double-bound)", async () => {
  const { boundedBy, withView } = await import("./folder-access");
  // The Share flow computes: requested ∩ granterCaps ∩ targetTeamCaps, +view.
  // Granter holds only [view, deploy]; even if they request manage_infra for a
  // target whose team caps include it, the granter's own bound removes it.
  const requested = ["deploy", "manage_infra"] as const;
  const granterCaps = ["view", "deploy"] as const;
  const targetTeamCaps = ["view", "deploy", "manage_infra"] as const;
  const result = withView(
    boundedBy(boundedBy([...requested], [...granterCaps]), [...targetTeamCaps]),
  );
  assert.deepEqual(result, ["view", "deploy"], "manage_infra can't be granted");
});

test("a grantee never exceeds their own team caps", async () => {
  const { boundedBy, withView } = await import("./folder-access");
  // Grantee's team caps are just [view]; granting [view, deploy] yields [view].
  const requested = ["view", "deploy"] as const;
  const granterCaps = ["view", "deploy", "manage_env"] as const;
  const granteeTeamCaps = ["view"] as const;
  const result = withView(
    boundedBy(boundedBy([...requested], [...granterCaps]), [...granteeTeamCaps]),
  );
  assert.deepEqual(result, ["view"], "clamped to the grantee's team caps");
});
