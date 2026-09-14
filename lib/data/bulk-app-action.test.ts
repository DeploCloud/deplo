import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq, inArray } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { folders as foldersTable } from "../db/schema/control-plane/projects";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, seedApp } from "./app-graph-test-helpers";
import { createFolder, moveAppToFolder } from "./folders";
import { createProject } from "./projects/lifecycle";
import { moveAppToProject, moveAppToEnvironment } from "./projects/placement";
import { createEnvironment } from "./environments";
import { bulkAppAction } from "./apps/bulk";

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
    activities, environments, team_project_order, project_grants, projects,
    folders, apps, servers,
    membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    teams: [
      { id: TEAM_A, slug: "alpha" },
      { id: TEAM_B, slug: "beta" },
    ],
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

async function touched(ids: string[]): Promise<string[]> {
  const rows = await db
    .select({ id: appsTable.id, status: appsTable.status })
    .from(appsTable)
    .where(inArray(appsTable.id, ids));
  return rows
    .filter((r) => r.status === "active")
    .map((r) => r.id)
    .sort();
}

test("a folder acts on its whole subtree, and on nothing outside it", async () => {
  await asOwner(async () => {
    const top = await createFolder("Top");
    const nested = await createFolder("Nested", null, top.id);
    const other = await createFolder("Other");
    for (const id of ["svc_top", "svc_nested", "svc_other", "svc_loose"]) {
      await seedApp(db, { id, teamId: TEAM_A, status: "idle" });
    }
    await moveAppToFolder("svc_top", top.id);
    await moveAppToFolder("svc_nested", nested.id);
    await moveAppToFolder("svc_other", other.id);

    const res = await bulkAppAction("stop", { folderId: top.id });
    assert.equal(res.ok, 0);
    assert.equal(res.failed, 2, "the nested app is part of the folder");
    assert.match(String(res.error), /not provisioned|unreachable/i);

    assert.deepEqual(
      await touched(["svc_top", "svc_nested", "svc_other", "svc_loose"]),
      ["svc_nested", "svc_top"],
      "a sibling folder and a top-level app are left alone",
    );
  });
});

test("a project acts on every environment, and on nothing outside it", async () => {
  await asOwner(async () => {
    const project = await createProject("Shop");
    const other = await createProject("Blog");
    for (const id of ["svc_prod", "svc_staging", "svc_blog"]) {
      await seedApp(db, { id, teamId: TEAM_A, status: "idle" });
    }
    const staging = await createEnvironment(project.id, "Staging");
    await moveAppToProject("svc_prod", project.id);
    await moveAppToProject("svc_staging", project.id);
    await moveAppToEnvironment("svc_staging", staging.id);
    await moveAppToProject("svc_blog", other.id);

    // A pre-ADR-0009 shape the project tile still counts: a folder with no project link.
    const legacy = await createFolder("Legacy");
    await seedApp(db, { id: "svc_legacy", teamId: TEAM_A, status: "idle" });
    await moveAppToFolder("svc_legacy", legacy.id);
    await db
      .update(foldersTable)
      .set({ projectId: project.id })
      .where(eq(foldersTable.id, legacy.id));

    const res = await bulkAppAction("stop", { projectId: project.id });
    assert.equal(res.failed, 3);
    assert.deepEqual(
      await touched(["svc_prod", "svc_staging", "svc_legacy", "svc_blog"]),
      ["svc_legacy", "svc_prod", "svc_staging"],
      "the other project is untouched",
    );
  });
});

test("another team's folder is empty, not an error", async () => {
  // Not an existence oracle: an unseeable folder finds nothing rather than refusing.
  const foreign = "fld_beta";
  await db.insert(foldersTable).values({
    id: foreign,
    teamId: TEAM_B,
    name: "Beta",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await seedApp(db, { id: "svc_beta", teamId: TEAM_B, status: "idle" });
  await db
    .update(appsTable)
    .set({ folderId: foreign })
    .where(eq(appsTable.id, "svc_beta"));

  await asOwner(async () => {
    const res = await bulkAppAction("stop", { folderId: foreign });
    assert.deepEqual(res, { ok: 0, failed: 0, error: null });
  });
  assert.deepEqual(await touched(["svc_beta"]), []);
});

test("without a folder or a project there is nothing to act on", async () => {
  await asOwner(async () => {
    await assert.rejects(
      () => bulkAppAction("restart", {}),
      /folder or a project/,
    );
  });
});
