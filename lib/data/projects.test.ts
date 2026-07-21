import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  folders as foldersTable,
  apps as appsTable,
  projects as projectsTable,
  environments as environmentsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import { seedServer, seedApp } from "./app-graph-test-helpers";
import {
  createProject,
  listProjects,
  getProjectBySlug,
  renameProject,
  setProjectColor,
  deleteProject,
  reorderProjects,
  moveAppToProject,
  moveAppToEnvironment,
} from "./projects";
import { createFolder, moveAppToFolder } from "./folders";
import { createApp } from "./apps";
import {
  listEnvironmentsForProject,
  createEnvironment,
  setDefaultEnvironment,
  deleteEnvironment,
} from "./environments";

/**
 * Integration tests for the Project data layer (ADR-0008, remodeled per
 * ADR-0009: a project is an ADVANCED FOLDER whose contents live per
 * Environment) against pglite. Proves: team-scoped slugging, live counts,
 * environment membership on move-in (default env), moveAppToEnvironment,
 * the one-home folder/project exclusivity, and a delete that re-parents
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

test("createProject: mints a prc_ id, a team-unique slug, and lands in listProjects", async () => {
  await asOwner(async () => {
    const p = await createProject("My App", "#3366ff");
    assert.match(p.id, /^prc_/);
    assert.equal(p.slug, "my-app");
    assert.equal(p.color, "#3366ff");
    assert.equal(p.folderCount, 0);
    assert.equal(p.appCount, 0);
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

test("moveAppToProject lands in the DEFAULT environment and updates live counts", async () => {
  await asOwner(async () => {
    const p = await createProject("Container");
    await seedApp(db, { id: "prj_svc1", teamId: TEAM_A });
    await moveAppToProject("prj_svc1", p.id);
    const got = (await listProjects()).find((x) => x.id === p.id)!;
    assert.equal(got.appCount, 1);
    assert.equal(got.environmentCount, 3);
    const row = (
      await db
        .select({
          projectId: appsTable.projectId,
          environmentId: appsTable.environmentId,
        })
        .from(appsTable)
        .where(eq(appsTable.id, "prj_svc1"))
    )[0];
    assert.equal(row.projectId, p.id);
    const prod = (await listEnvironmentsForProject(p.id)).find((e) => e.isDefault)!;
    assert.equal(row.environmentId, prod.id, "lands in the default environment");
    // move back out → project AND environment cleared, count drops
    await moveAppToProject("prj_svc1", null);
    const out = (
      await db
        .select({
          projectId: appsTable.projectId,
          environmentId: appsTable.environmentId,
        })
        .from(appsTable)
        .where(eq(appsTable.id, "prj_svc1"))
    )[0];
    assert.equal(out.projectId, null);
    assert.equal(out.environmentId, null);
    assert.equal((await listProjects())[0].appCount, 0);
  });
});

test("moveAppToEnvironment switches environments; the project follows", async () => {
  await asOwner(async () => {
    const p = await createProject("Container");
    await seedApp(db, { id: "prj_svc1", teamId: TEAM_A });
    const dev = (await listEnvironmentsForProject(p.id)).find(
      (e) => e.slug === "development",
    )!;
    // Straight from the top level into a specific environment.
    await moveAppToEnvironment("prj_svc1", dev.id);
    const row = (
      await db
        .select({
          projectId: appsTable.projectId,
          environmentId: appsTable.environmentId,
        })
        .from(appsTable)
        .where(eq(appsTable.id, "prj_svc1"))
    )[0];
    assert.equal(row.projectId, p.id, "the project follows the environment");
    assert.equal(row.environmentId, dev.id);
  });
});

test("one home only: filing into a folder leaves the project, and vice versa", async () => {
  await asOwner(async () => {
    const p = await createProject("Container");
    const f = await createFolder("Docs");
    await seedApp(db, { id: "prj_svc1", teamId: TEAM_A });
    await moveAppToProject("prj_svc1", p.id);
    // Project → folder: project/environment cleared.
    await moveAppToFolder("prj_svc1", f.id);
    let row = (
      await db
        .select({
          folderId: appsTable.folderId,
          projectId: appsTable.projectId,
          environmentId: appsTable.environmentId,
        })
        .from(appsTable)
        .where(eq(appsTable.id, "prj_svc1"))
    )[0];
    assert.equal(row.folderId, f.id);
    assert.equal(row.projectId, null);
    assert.equal(row.environmentId, null);
    // Folder → project: folder cleared.
    await moveAppToProject("prj_svc1", p.id);
    row = (
      await db
        .select({
          folderId: appsTable.folderId,
          projectId: appsTable.projectId,
          environmentId: appsTable.environmentId,
        })
        .from(appsTable)
        .where(eq(appsTable.id, "prj_svc1"))
    )[0];
    assert.equal(row.folderId, null);
    assert.equal(row.projectId, p.id);
    assert.notEqual(row.environmentId, null);
  });
});

test("deleteEnvironment re-parents its apps to the default environment", async () => {
  await asOwner(async () => {
    const p = await createProject("Container");
    await seedApp(db, { id: "prj_svc1", teamId: TEAM_A });
    const envs = await listEnvironmentsForProject(p.id);
    const dev = envs.find((e) => e.slug === "development")!;
    const prod = envs.find((e) => e.isDefault)!;
    await moveAppToEnvironment("prj_svc1", dev.id);
    await deleteEnvironment(dev.id);
    const row = (
      await db
        .select({
          projectId: appsTable.projectId,
          environmentId: appsTable.environmentId,
        })
        .from(appsTable)
        .where(eq(appsTable.id, "prj_svc1"))
    )[0];
    assert.equal(row.projectId, p.id, "stays in the project");
    assert.equal(row.environmentId, prod.id, "falls back to the default environment");
  });
});

test("deleteProject re-parents its apps (and legacy folders) to the top level (no cascade)", async () => {
  await asOwner(async () => {
    const p = await createProject("Container");
    const f = await createFolder("Docs");
    await seedApp(db, { id: "prj_svc1", teamId: TEAM_A });
    // A LEGACY folder-in-project row (pre-ADR-0009; the UI can no longer write
    // this) — deleteProject must still clear it.
    await db
      .update(foldersTable)
      .set({ projectId: p.id })
      .where(eq(foldersTable.id, f.id));
    await moveAppToProject("prj_svc1", p.id);
    await deleteProject(p.id);
    // The project is gone…
    assert.equal((await listProjects()).length, 0);
    // …but the folder and service survive, back at the top level.
    const folderRow = await db
      .select({ projectId: foldersTable.projectId })
      .from(foldersTable)
      .where(eq(foldersTable.id, f.id));
    const svcRow = await db
      .select({
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable)
      .where(eq(appsTable.id, "prj_svc1"));
    assert.equal(folderRow.length, 1);
    assert.equal(folderRow[0].projectId, null);
    assert.equal(svcRow.length, 1);
    assert.equal(svcRow[0].projectId, null);
    assert.equal(svcRow[0].environmentId, null);
  });
});

test("createProject seeds Development / Preview / Production (Production is default)", async () => {
  await asOwner(async () => {
    const p = await createProject("Seeded");
    const envs = await listEnvironmentsForProject(p.id);
    assert.deepEqual(
      envs.map((e) => e.name),
      ["Development", "Preview", "Production"],
      "three defaults, in order",
    );
    assert.deepEqual(
      envs.map((e) => e.kind),
      ["development", "preview", "production"],
    );
    const def = envs.filter((e) => e.isDefault);
    assert.equal(def.length, 1);
    assert.equal(def[0].name, "Production");
    assert.match(envs[0].id, /^environ_/);
  });
});

test("environment CRUD: add custom, switch default, delete guards", async () => {
  await asOwner(async () => {
    const p = await createProject("Envs");
    const custom = await createEnvironment(p.id, "Staging");
    assert.equal(custom.kind, "custom");
    assert.equal(custom.slug, "staging");
    assert.equal((await listEnvironmentsForProject(p.id)).length, 4);

    // Can't delete the default (Production) until another is made default.
    const prod = (await listEnvironmentsForProject(p.id)).find((e) => e.isDefault)!;
    await assert.rejects(() => deleteEnvironment(prod.id), /default environment/);

    // Switch default to the custom one, then Production is deletable.
    await setDefaultEnvironment(custom.id);
    const after = await listEnvironmentsForProject(p.id);
    assert.equal(after.filter((e) => e.isDefault).length, 1);
    assert.equal(after.find((e) => e.isDefault)!.id, custom.id);
    await deleteEnvironment(prod.id);
    assert.equal((await listEnvironmentsForProject(p.id)).length, 3);
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

/* ------------------------------------------------------------------ */
/* Creating an app INSIDE a project environment (placement at birth)   */
/* ------------------------------------------------------------------ */

/** A hermetic create: "upload" is born idle, so nothing dials an agent. */
const newApp = (
  placement: {
    folderId?: string | null;
    projectId?: string | null;
    environmentId?: string | null;
  },
  name = "Made here",
) => createApp({ name, source: "upload" as const, repo: null, ...placement });

const placementOf = async (appId: string) =>
  (
    await db
      .select({
        folderId: appsTable.folderId,
        projectId: appsTable.projectId,
        environmentId: appsTable.environmentId,
      })
      .from(appsTable)
      .where(eq(appsTable.id, appId))
  )[0];

test("createApp lands in the environment it was created from", async () => {
  await asOwner(async () => {
    const p = await createProject("Container");
    const dev = (await listEnvironmentsForProject(p.id)).find(
      (e) => e.slug === "development",
    )!;
    const app = await newApp({ projectId: p.id, environmentId: dev.id });
    const row = await placementOf(app.id);
    assert.equal(row.projectId, p.id, "the project follows the environment");
    assert.equal(row.environmentId, dev.id);
    assert.equal(row.folderId, null, "one home only");
    // It shows up in the project's live count, i.e. in the drill-in the user
    // was standing in — the whole point of placing at birth.
    assert.equal((await listProjects())[0].appCount, 1);
  });
});

test("createApp with a project but no environment uses the default one", async () => {
  await asOwner(async () => {
    const p = await createProject("Container");
    const app = await newApp({ projectId: p.id });
    const prod = (await listEnvironmentsForProject(p.id)).find((e) => e.isDefault)!;
    assert.equal((await placementOf(app.id)).environmentId, prod.id);
  });
});

test("createApp rejects a project/environment pair that disagree", async () => {
  await asOwner(async () => {
    const a = await createProject("A");
    const b = await createProject("B");
    const bDev = (await listEnvironmentsForProject(b.id))[0]!;
    await assert.rejects(
      () => newApp({ projectId: a.id, environmentId: bDev.id }),
      /environment not found/i,
    );
  });
});

test("createApp rejects another team's environment", async () => {
  // A project + environment owned by TEAM_B, seeded directly (USER_1 is only a
  // member of TEAM_A, so it is unreachable through the data layer).
  const T0 = "2026-01-01T00:00:00.000Z";
  await db.insert(projectsTable).values({
    id: "prc_foreign",
    teamId: TEAM_B,
    name: "Foreign",
    slug: "foreign",
    color: null,
    ownerUserId: null,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(environmentsTable).values({
    id: "environ_foreign",
    projectId: "prc_foreign",
    name: "Production",
    slug: "production",
    kind: "production",
    isDefault: true,
    position: 0,
    createdAt: T0,
    updatedAt: T0,
  });
  await asOwner(async () => {
    await assert.rejects(
      () => newApp({ environmentId: "environ_foreign" }),
      /environment not found/i,
    );
    await assert.rejects(
      () => newApp({ projectId: "prc_foreign" }),
      /project not found/i,
    );
  });
  assert.equal(
    (await db.select().from(appsTable)).length,
    0,
    "nothing was created for the foreign placements",
  );
});
