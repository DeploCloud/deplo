import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { folders as foldersTable } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B } from "./identity-test-helpers";
import { createFolder } from "./folders";

/**
 * The `createFolder` nesting contract against pglite. This is the data-layer
 * guarantee behind the Overview "New folder / New subfolder" flow: a folder made
 * while a folder is open must land UNDER it (`parentId`), not at the top level —
 * and an unknown/foreign parent must be rejected rather than stranding a subtree.
 * (The UI wiring that actually threads the open folder through as `parentId` lives
 * in `AddNewMenu`; this locks the contract that wiring depends on.)
 */

let db: TestDb;
let pg: PGlite;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

const OWNER_A = "u_owner_a";
const OWNER_B = "u_owner_b";

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId }, fn);

beforeEach(async () => {
  await pg.exec(`truncate table
    team_folder_order, folders,
    membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      { id: OWNER_A, teamId: TEAM_A, role: "owner" },
      { id: OWNER_B, teamId: TEAM_B, role: "owner" },
    ],
  });
});

test("a folder created with a parent nests under it (parentId is set)", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    const parent = await createFolder("Clients");
    assert.equal(parent.parentId ?? null, null, "the parent is a top-level folder");

    const child = await createFolder("Acme", null, parent.id);
    assert.equal(
      child.parentId,
      parent.id,
      "the child's parentId is the open folder — it nests, not top-level",
    );
  });
  // Persisted, not just returned.
  const rows = await db
    .select({ id: foldersTable.id, parentId: foldersTable.parentId })
    .from(foldersTable);
  const child = rows.find((r) => r.parentId != null);
  assert.ok(child, "a nested folder row exists in the table");
});

test("creating under an unknown parent is rejected (no orphaned subtree)", async () => {
  await as(OWNER_A, TEAM_A, async () => {
    await assert.rejects(
      () => createFolder("Ghost child", null, "fld_does_not_exist"),
      /parent folder not found/i,
    );
  });
});

test("a folder can't nest under another team's folder", async () => {
  const foreign = await as(OWNER_B, TEAM_B, () => createFolder("B-only"));
  await as(OWNER_A, TEAM_A, async () => {
    await assert.rejects(
      () => createFolder("Cross-team", null, foreign.id),
      /parent folder not found/i,
      "a parent from another team is not visible and must be rejected",
    );
  });
});
