import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { folders as foldersTable } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, seedApp } from "./app-graph-test-helpers";
import { createFolder, listFolders, moveAppToFolder } from "./folders";
import { createProject, listProjects, moveAppToProject } from "./projects";

/**
 * Integration tests for the LIVE COUNTS on folder and project tiles against
 * pglite. Proves the subtree semantics: a folder's appCount covers
 * everything nested anywhere beneath it (not just direct children), and a
 * project's appCount also reaches services filed inside a legacy
 * folder-in-project subtree (pre-ADR-0009 rows, which carry no project_id of
 * their own).
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

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

beforeEach(async () => {
  await pg.query(`truncate table
    environments, team_project_order, project_grants, projects,
    folders, apps, servers,
    membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }, { id: TEAM_B, slug: "beta" }],
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

test("folder appCount covers the whole subtree, subfolderCount stays immediate", async () => {
  await asOwner(async () => {
    // top → mid → leaf, with one service at each level.
    const top = await createFolder("Top");
    const mid = await createFolder("Mid", null, top.id);
    const leaf = await createFolder("Leaf", null, mid.id);
    await seedApp(db, { id: "svc_top", teamId: TEAM_A });
    await seedApp(db, { id: "svc_mid", teamId: TEAM_A });
    await seedApp(db, { id: "svc_leaf", teamId: TEAM_A });
    await moveAppToFolder("svc_top", top.id);
    await moveAppToFolder("svc_mid", mid.id);
    await moveAppToFolder("svc_leaf", leaf.id);

    const byId = new Map((await listFolders()).map((f) => [f.id, f]));
    assert.equal(byId.get(top.id)?.appCount, 3, "top sees its whole subtree");
    assert.equal(byId.get(mid.id)?.appCount, 2, "mid sees itself + leaf");
    assert.equal(byId.get(leaf.id)?.appCount, 1);
    // The "· N folders" part of the tile label stays IMMEDIATE children only.
    assert.equal(byId.get(top.id)?.subfolderCount, 1);
    assert.equal(byId.get(mid.id)?.subfolderCount, 1);
    assert.equal(byId.get(leaf.id)?.subfolderCount, 0);
  });
});

test("an empty parent over populated subfolders no longer reads 0", async () => {
  await asOwner(async () => {
    // The reported shape: a top-level folder holding only subfolders, with the
    // services living in (some of) the subfolders.
    const parent = await createFolder("Parent");
    const a = await createFolder("A", null, parent.id);
    const b = await createFolder("B", null, parent.id);
    await createFolder("C (empty)", null, parent.id);
    await seedApp(db, { id: "svc_a1", teamId: TEAM_A });
    await seedApp(db, { id: "svc_a2", teamId: TEAM_A });
    await seedApp(db, { id: "svc_b1", teamId: TEAM_A });
    await moveAppToFolder("svc_a1", a.id);
    await moveAppToFolder("svc_a2", a.id);
    await moveAppToFolder("svc_b1", b.id);

    const got = (await listFolders()).find((f) => f.id === parent.id)!;
    assert.equal(got.appCount, 3, "nothing direct, everything via subfolders");
    assert.equal(got.subfolderCount, 3);
  });
});

test("project appCount reaches services inside a legacy folder-in-project subtree", async () => {
  await asOwner(async () => {
    const p = await createProject("Container");
    const legacy = await createFolder("Legacy");
    const nested = await createFolder("Nested", null, legacy.id);
    // A LEGACY folder-in-project row (pre-ADR-0009; the UI can no longer write
    // this) — its services must still count toward the project.
    await db
      .update(foldersTable)
      .set({ projectId: p.id })
      .where(eq(foldersTable.id, legacy.id));
    await seedApp(db, { id: "svc_direct", teamId: TEAM_A });
    await seedApp(db, { id: "svc_legacy", teamId: TEAM_A });
    await seedApp(db, { id: "svc_nested", teamId: TEAM_A });
    await seedApp(db, { id: "svc_outside", teamId: TEAM_A });
    await moveAppToProject("svc_direct", p.id);
    await moveAppToFolder("svc_legacy", legacy.id);
    await moveAppToFolder("svc_nested", nested.id);

    const got = (await listProjects()).find((x) => x.id === p.id)!;
    assert.equal(
      got.appCount,
      3,
      "direct + legacy folder + nested subfolder; the loose service stays out",
    );
    assert.equal(got.folderCount, 1, "only the project-linked folder itself");
  });
});
