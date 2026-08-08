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
    boundedBy(["deploy_apps", "manage_backups", "view"], ["view", "deploy_apps"]),
    ["view", "deploy_apps"],
    "manage_infra dropped (out of bound); canonical order",
  );
  assert.deepEqual(
    boundedBy(["manage_env", "deploy_apps"], ["deploy_apps", "manage_env", "view"]),
    ["deploy_apps", "manage_env"],
    "canonical order regardless of input order",
  );
});

test("boundedBy is empty when nothing overlaps", async () => {
  const { boundedBy } = await import("./folder-access");
  assert.deepEqual(boundedBy(["manage_backups"], ["view", "deploy_apps"]), []);
  assert.deepEqual(boundedBy([], ["view", "deploy_apps"]), []);
  assert.deepEqual(boundedBy(["deploy_apps"], []), []);
});

test("withView always includes view, in canonical order", async () => {
  const { withView } = await import("./folder-access");
  assert.deepEqual(withView([]), ["view"], "bare access still reads view");
  assert.deepEqual(
    withView(["deploy_apps"]),
    ["view", "deploy_apps"],
    "view is prepended in canonical order",
  );
  assert.deepEqual(
    withView(["deploy_apps", "view"]),
    ["view", "deploy_apps"],
    "no duplicate view",
  );
});

test("a granter can never hand out a capability they lack (double-bound)", async () => {
  const { boundedBy, withView } = await import("./folder-access");
  const { NODE_GRANTABLE_CAPABILITIES } = await import("../membership-shared");
  // The Share flow computes: requested ∩ granterCaps ∩ NODE_GRANTABLE, +view.
  // Granter holds only [view, deploy]; even if they request manage_backups,
  // their own bound removes it. This is the bound ADR-0016 KEPT.
  const requested = ["deploy_apps", "manage_backups"] as const;
  const granterCaps = ["view", "deploy_apps"] as const;
  const result = withView(
    boundedBy(boundedBy([...requested], [...granterCaps]), NODE_GRANTABLE_CAPABILITIES),
  );
  assert.deepEqual(result, ["view", "deploy_apps"], "manage_backups can't be granted");
});

test("a node grant can never name a team-wide capability", async () => {
  const { NODE_GRANTABLE_CAPABILITIES, PROJECT_SCOPED_CAPABILITIES } = await import(
    "../membership-shared"
  );
  // The bound that replaced the grantee clamp. Nothing in here can satisfy the
  // last-admin check, mint a credential, or re-share, so a node grant is never a
  // route back to team administration however it is asked for.
  for (const cap of [
    "manage_members",
    "manage_roles",
    "manage_team",
    "delete_team",
    "manage_tokens",
    "manage_registries",
    "manage_git",
    "manage_backup_destinations",
    "manage_notifications",
    "manage_environments",
    "create_databases",
    "delete_databases",
  ] as const) {
    assert.ok(
      !NODE_GRANTABLE_CAPABILITIES.includes(cap),
      `${cap} must not be node-grantable`,
    );
  }
  // It is the token's project set plus exactly three, for the reasons documented
  // beside the constant.
  for (const cap of PROJECT_SCOPED_CAPABILITIES) {
    assert.ok(NODE_GRANTABLE_CAPABILITIES.includes(cap), `${cap} is node-grantable`);
  }
  const extra = NODE_GRANTABLE_CAPABILITIES.filter(
    (c) => !PROJECT_SCOPED_CAPABILITIES.includes(c),
  );
  assert.deepEqual(extra.sort(), ["delete_folders", "move_apps", "organize_folders"]);
});
