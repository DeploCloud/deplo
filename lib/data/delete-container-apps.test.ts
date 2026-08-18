import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq, inArray } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  apps as appsTable,
  folders as foldersTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, seedApp } from "./app-graph-test-helpers";
import { createFolder, deleteFolder, moveAppToFolder } from "./folders";
import {
  createProject,
  deleteProject,
  moveAppToProject,
  moveAppToEnvironment,
} from "./projects";
import { createEnvironment } from "./environments";

/**
 * The "Delete all apps" option on a folder's / project's delete: which apps it
 * actually takes with it, and what the default delete still keeps.
 *
 * An app is deleted in two beats - stamped `deleting_at` under the caller's
 * gate, then torn down and dropped behind the response - so both halves are
 * asserted: `doomed()` reads the stamp (or the already-dropped row), and each
 * test waits for the rows to actually go, which is also what keeps the seeded
 * server's failing agent calls from running into the next test.
 */

let db: TestDb;
let pg: PGlite;

const USER_2 = "user_2";

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
    activities, environments, team_project_order, project_grants, projects,
    folders, apps, servers,
    membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      // Tidies the grid, destroys nothing: the folder is theirs to delete, the
      // apps in it are not.
      {
        id: USER_2,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "create_folders", "delete_folders", "move_apps"],
      },
    ],
  });
  await seedServer(db);
});

/** The apps on their way out: stamped for deletion, or already dropped. */
async function doomed(ids: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: appsTable.id, deletingAt: appsTable.deletingAt })
    .from(appsTable)
    .where(inArray(appsTable.id, ids));
  const alive = new Map(rows.map((r) => [r.id, r.deletingAt] as const));
  return ids.filter((id) => !alive.has(id) || alive.get(id) != null).sort();
}

/** Let the background teardown finish, so the next test starts on a clean db. */
async function waitGone(ids: string[]): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const rows = await db
      .select({ id: appsTable.id })
      .from(appsTable)
      .where(inArray(appsTable.id, ids));
    if (rows.length === 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("the teardown never finished");
}

test("a folder's Delete all apps takes its whole subtree, and nothing else", async () => {
  await asOwner(async () => {
    const top = await createFolder("Top");
    const nested = await createFolder("Nested", null, top.id);
    const other = await createFolder("Other");
    for (const id of ["svc_top", "svc_nested", "svc_other", "svc_loose"]) {
      await seedApp(db, { id, teamId: TEAM_A });
    }
    await moveAppToFolder("svc_top", top.id);
    await moveAppToFolder("svc_nested", nested.id);
    await moveAppToFolder("svc_other", other.id);

    await deleteFolder(top.id, { deleteApps: true });

    assert.deepEqual(
      await doomed(["svc_top", "svc_nested", "svc_other", "svc_loose"]),
      ["svc_nested", "svc_top"],
      "a sibling folder and a top-level app are left alone",
    );
    // The option deletes APPS, not structure: the subfolder still falls back to
    // the deleted folder's own parent, like it does without the option.
    const left = await db
      .select({ id: foldersTable.id, parentId: foldersTable.parentId })
      .from(foldersTable);
    assert.deepEqual(
      left.map((f) => f.id).sort(),
      [nested.id, other.id].sort(),
    );
    assert.equal(left.find((f) => f.id === nested.id)?.parentId, null);
    await waitGone(["svc_top", "svc_nested"]);
  });
});

test("without the option the folder's apps are kept", async () => {
  await asOwner(async () => {
    const top = await createFolder("Top");
    await seedApp(db, { id: "svc_top", teamId: TEAM_A });
    await moveAppToFolder("svc_top", top.id);

    await deleteFolder(top.id);

    assert.deepEqual(await doomed(["svc_top"]), []);
    const rows = await db
      .select({ id: appsTable.id, folderId: appsTable.folderId })
      .from(appsTable);
    assert.deepEqual(rows, [{ id: "svc_top", folderId: null }]);
  });
});

test("a project's Delete all apps covers every environment and a folder filed under it", async () => {
  await asOwner(async () => {
    const project = await createProject("Shop");
    const other = await createProject("Blog");
    for (const id of ["svc_prod", "svc_staging", "svc_blog"]) {
      await seedApp(db, { id, teamId: TEAM_A });
    }
    const staging = await createEnvironment(project.id, "Staging");
    await moveAppToProject("svc_prod", project.id);
    await moveAppToProject("svc_staging", project.id);
    await moveAppToEnvironment("svc_staging", staging.id);
    await moveAppToProject("svc_blog", other.id);
    // The pre-ADR-0009 shape the project tile still counts: a folder filed under
    // the project, with an app inside and no project link of its own.
    const legacy = await createFolder("Legacy");
    await seedApp(db, { id: "svc_legacy", teamId: TEAM_A });
    await moveAppToFolder("svc_legacy", legacy.id);
    await db
      .update(foldersTable)
      .set({ projectId: project.id })
      .where(eq(foldersTable.id, legacy.id));

    await deleteProject(project.id, { deleteApps: true });

    assert.deepEqual(
      await doomed(["svc_prod", "svc_staging", "svc_legacy", "svc_blog"]),
      ["svc_legacy", "svc_prod", "svc_staging"],
      "the other project is untouched",
    );
    assert.deepEqual(
      (await db.select({ id: projectsTable.id }).from(projectsTable)).map(
        (p) => p.id,
      ),
      [other.id],
    );
    await waitGone(["svc_prod", "svc_staging", "svc_legacy"]);
  });
});

test("one app the caller may not delete refuses the whole delete", async () => {
  await seedApp(db, { id: "svc_in", teamId: TEAM_A });
  await runWithIdentity({ userId: USER_2, teamId: TEAM_A }, async () => {
    const folder = await createFolder("Theirs");
    await moveAppToFolder("svc_in", folder.id);

    await assert.rejects(
      () => deleteFolder(folder.id, { deleteApps: true }),
      /permission/i,
    );

    // Nothing half-done: the app is neither stamped nor gone, and the folder it
    // was in is still there.
    assert.deepEqual(await doomed(["svc_in"]), []);
    assert.equal(
      (await db.select({ id: foldersTable.id }).from(foldersTable)).length,
      1,
    );
    // The plain delete, which is all they may do, still works.
    await deleteFolder(folder.id);
    assert.deepEqual(await doomed(["svc_in"]), []);
  });
});

test("another team's folder deletes nothing", async () => {
  await seedApp(db, { id: "svc_beta", teamId: TEAM_B });
  const foreign = "fld_beta";
  await db.insert(foldersTable).values({
    id: foreign,
    teamId: TEAM_B,
    name: "Beta",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await db
    .update(appsTable)
    .set({ folderId: foreign })
    .where(eq(appsTable.id, "svc_beta"));

  await asOwner(async () => {
    await assert.rejects(
      () => deleteFolder(foreign, { deleteApps: true }),
      /not found/i,
    );
  });
  assert.deepEqual(await doomed(["svc_beta"]), []);
});
