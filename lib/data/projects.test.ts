import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  folders as foldersTable,
  services as servicesTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, seedService } from "./service-graph-test-helpers";
import {
  createProject,
  listProjects,
  getProjectBySlug,
  renameProject,
  setProjectColor,
  deleteProject,
  reorderProjects,
  moveFolderToProject,
  moveServiceToProject,
} from "./projects";
import { createFolder } from "./folders";

/**
 * Integration tests for the Project CONTAINER data layer (ADR-0008 Phase 2)
 * against pglite. Proves the folder-like contract: team-scoped slugging, live
 * folder/service counts, additive move-in/move-out, and a delete that re-parents
 * contents to the top level rather than cascading.
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
    team_project_order, project_grants, projects,
    folders, services, servers,
    membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }, { id: TEAM_B, slug: "beta" }],
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

test("createProject: mints a prc_ id, a team-unique slug, and lands in listProjects", async () => {
  await asOwner(async () => {
    const p = await createProject("My App", "#3366ff");
    assert.match(p.id, /^prc_/);
    assert.equal(p.slug, "my-app");
    assert.equal(p.color, "#3366ff");
    assert.equal(p.folderCount, 0);
    assert.equal(p.serviceCount, 0);
    const list = await listProjects();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, p.id);
    assert.equal((await getProjectBySlug("my-app"))?.id, p.id);
  });
});

test("createProject: same name in a team gets a distinct slug", async () => {
  await asOwner(async () => {
    const a = await createProject("My App");
    const b = await createProject("My App");
    assert.equal(a.slug, "my-app");
    assert.equal(b.slug, "my-app-2");
  });
});

test("renameProject + setProjectColor mutate in place", async () => {
  await asOwner(async () => {
    const p = await createProject("Alpha");
    await renameProject(p.id, "Renamed");
    await setProjectColor(p.id, "#112233");
    const got = await getProjectBySlug(p.slug);
    assert.equal(got?.name, "Renamed");
    assert.equal(got?.color, "#112233");
    await setProjectColor(p.id, null);
    assert.equal((await getProjectBySlug(p.slug))?.color, null);
  });
});

test("moveFolderToProject / moveServiceToProject update the live counts", async () => {
  await asOwner(async () => {
    const p = await createProject("Container");
    const f = await createFolder("Docs");
    await seedService(db, { id: "prj_svc1", teamId: TEAM_A });
    await moveFolderToProject(f.id, p.id);
    await moveServiceToProject("prj_svc1", p.id);
    const got = (await listProjects()).find((x) => x.id === p.id)!;
    assert.equal(got.folderCount, 1);
    assert.equal(got.serviceCount, 1);
    // move the folder back out → count drops
    await moveFolderToProject(f.id, null);
    assert.equal((await listProjects())[0].folderCount, 0);
  });
});

test("deleteProject re-parents its folders and services to the top level (no cascade)", async () => {
  await asOwner(async () => {
    const p = await createProject("Container");
    const f = await createFolder("Docs");
    await seedService(db, { id: "prj_svc1", teamId: TEAM_A });
    await moveFolderToProject(f.id, p.id);
    await moveServiceToProject("prj_svc1", p.id);
    await deleteProject(p.id);
    // The container is gone…
    assert.equal((await listProjects()).length, 0);
    // …but the folder and service survive, back at the top level.
    const folderRow = await db
      .select({ projectId: foldersTable.projectId })
      .from(foldersTable)
      .where(eq(foldersTable.id, f.id));
    const svcRow = await db
      .select({ projectId: servicesTable.projectId })
      .from(servicesTable)
      .where(eq(servicesTable.id, "prj_svc1"));
    assert.equal(folderRow.length, 1);
    assert.equal(folderRow[0].projectId, null);
    assert.equal(svcRow.length, 1);
    assert.equal(svcRow[0].projectId, null);
  });
});

test("reorderProjects persists a team-wide order and is self-healing", async () => {
  await asOwner(async () => {
    const a = await createProject("A");
    const b = await createProject("B");
    const c = await createProject("C");
    // Request only b,a — c must be appended, unknown ids dropped.
    await reorderProjects([b.id, a.id, "prc_ghost"]);
    const order = (await listProjects()).map((p) => p.id);
    assert.deepEqual(order, [b.id, a.id, c.id]);
  });
});
