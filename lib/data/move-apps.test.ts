import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  apps as appsTable,
  environments as environmentsTable,
  folders as foldersTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "./identity-test-helpers";
import { seedApp, seedServer, TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { moveAppToFolder, moveAppsToFolder } from "./folders";
import { moveAppToProject, moveAppToEnvironment } from "./projects";
import { transferAppToTeam, appTransferInfo } from "./app-transfer";
import { ALL_CAPABILITIES, type Capability } from "../types";

/**
 * What "Move & reorder apps" actually buys you.
 *
 * The permission names one thing - relocating an app - and it is spread over
 * four call sites (folder, project, environment, another team), each with its
 * own second gate. This drives all of them as a member who holds `move_apps`
 * and NOTHING else, so a move that only works for a team admin shows up as a
 * failure here rather than as a permission that looks granted and does nothing.
 *
 * The mirror case matters as much: a member holding the other thirty-nine
 * permissions must not be able to move anything.
 */

let db: TestDb;
let pg: PGlite;

const MOVER = "user_mover";
const APP = "prj_movable";
const APP_2 = "prj_movable_2";
const MY_FOLDER = "fld_mine";
const THEIR_FOLDER = "fld_theirs";
const PROJECT = "prc_target";
const ENV_MAIN = "environ_main";
const ENV_SIDE = "environ_side";
const T0 = "2026-01-01T00:00:00.000Z";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec(
    `truncate table projects, environments, activities restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      // The subject: one permission, in both teams (the transfer needs a
      // membership on the far side too).
      { id: MOVER, teamId: TEAM_A, role: "member", capabilities: ["view", "move_apps"] },
      { id: `${MOVER}_b`, teamId: TEAM_B, role: "owner" },
    ],
  });
  await pg.exec(
    `insert into memberships (id, user_id, team_id, role, created_at)
       values ('mem_mover_b', '${MOVER}', '${TEAM_B}', 'member', '${T0}');
     insert into membership_capabilities (membership_id, capability)
       values ('mem_mover_b', 'view'), ('mem_mover_b', 'move_apps');`,
  );
  await seedServer(db);
  await db.insert(foldersTable).values([
    { id: MY_FOLDER, teamId: TEAM_A, name: "Mine", ownerUserId: MOVER, createdAt: T0, updatedAt: T0 },
    { id: THEIR_FOLDER, teamId: TEAM_A, name: "Theirs", ownerUserId: USER_1, createdAt: T0, updatedAt: T0 },
  ]);
  await db.insert(projectsTable).values({
    id: PROJECT,
    teamId: TEAM_A,
    name: "Target",
    slug: "target",
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(environmentsTable).values([
    { id: ENV_MAIN, projectId: PROJECT, name: "production", slug: "production", kind: "production", isDefault: true, position: 0, createdAt: T0, updatedAt: T0 },
    { id: ENV_SIDE, projectId: PROJECT, name: "staging", slug: "staging", kind: "preview", isDefault: false, position: 1, createdAt: T0, updatedAt: T0 },
  ]);
  await seedApp(db, { id: APP, teamId: TEAM_A, slug: "movable" });
  await seedApp(db, { id: APP_2, teamId: TEAM_A, slug: "movable-2" });
});

const asMover = <T>(fn: () => Promise<T>, teamId = TEAM_A): Promise<T> =>
  runWithIdentity({ userId: MOVER, teamId }, fn);

/** Give the subject a different set (always keeping the `view` floor). */
async function setCaps(caps: Capability[]): Promise<void> {
  await pg.exec(`delete from membership_capabilities where membership_id = 'mem_${MOVER}';`);
  const wanted = new Set<Capability>([...caps, "view"]);
  const values = ALL_CAPABILITIES.filter((c) => wanted.has(c))
    .map((c) => `('mem_${MOVER}', '${c}')`)
    .join(", ");
  await pg.exec(
    `insert into membership_capabilities (membership_id, capability) values ${values};`,
  );
}

async function placementOf(appId = APP) {
  const [row] = await db
    .select({
      teamId: appsTable.teamId,
      folderId: appsTable.folderId,
      projectId: appsTable.projectId,
      environmentId: appsTable.environmentId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, appId));
  return row;
}

/* ------------------------------------------------------------------ */
/* It works                                                            */
/* ------------------------------------------------------------------ */

test("move_apps alone files an app into a folder and pulls it back out", async () => {
  await asMover(() => moveAppToFolder(APP, MY_FOLDER));
  assert.equal((await placementOf()).folderId, MY_FOLDER, "the app landed in the folder");

  await asMover(() => moveAppToFolder(APP, null));
  assert.equal((await placementOf()).folderId, null, "and came back out");
});

test("move_apps alone moves an app into a project, between its environments, and out", async () => {
  await asMover(() => moveAppToProject(APP, PROJECT));
  const filed = await placementOf();
  assert.equal(filed.projectId, PROJECT);
  assert.equal(filed.environmentId, ENV_MAIN, "entering a project lands in its default environment");

  await asMover(() => moveAppToEnvironment(APP, ENV_SIDE));
  assert.equal((await placementOf()).environmentId, ENV_SIDE);

  await asMover(() => moveAppToProject(APP, null));
  const out = await placementOf();
  assert.equal(out.projectId, null);
  assert.equal(out.environmentId, null, "leaving the project leaves its environment too");
});

test("move_apps alone moves a whole selection at once", async () => {
  await asMover(() => moveAppsToFolder([APP, APP_2], MY_FOLDER));
  assert.equal((await placementOf(APP)).folderId, MY_FOLDER);
  assert.equal((await placementOf(APP_2)).folderId, MY_FOLDER);
});

test("filing an app into a folder takes it out of its project, and vice versa", async () => {
  // An app lives in exactly ONE place (ADR-0009); the UI offers both moves from
  // the same menu, so the two must not be able to leave it in both.
  await asMover(() => moveAppToProject(APP, PROJECT));
  await asMover(() => moveAppToFolder(APP, MY_FOLDER));
  const inFolder = await placementOf();
  assert.equal(inFolder.folderId, MY_FOLDER);
  assert.equal(inFolder.projectId, null);
  assert.equal(inFolder.environmentId, null);

  await asMover(() => moveAppToProject(APP, PROJECT));
  const inProject = await placementOf();
  assert.equal(inProject.projectId, PROJECT);
  assert.equal(inProject.folderId, null);
});

/* ------------------------------------------------------------------ */
/* And it stops where it should                                        */
/* ------------------------------------------------------------------ */

test("a folder the mover can't see is not a destination", async () => {
  await assert.rejects(
    () => asMover(() => moveAppToFolder(APP, THEIR_FOLDER)),
    /not found/i,
    "someone else's private folder answers like one that isn't there",
  );
  assert.equal((await placementOf()).folderId, null);
});

test("the other thirty-nine permissions move nothing", async () => {
  await setCaps(ALL_CAPABILITIES.filter((c) => c !== "move_apps"));
  for (const [what, run] of [
    ["into a folder", () => moveAppToFolder(APP, MY_FOLDER)],
    ["in bulk", async () => void (await moveAppsToFolder([APP], MY_FOLDER))],
    ["into a project", () => moveAppToProject(APP, PROJECT)],
    ["into an environment", () => moveAppToEnvironment(APP, ENV_SIDE)],
  ] as const) {
    await assert.rejects(
      () => asMover(run),
      /permission|not found/i,
      `${what} went through without move_apps`,
    );
  }
  const still = await placementOf();
  assert.equal(still.folderId, null);
  assert.equal(still.projectId, null);
});

/* ------------------------------------------------------------------ */
/* Crossing a team boundary needs more than move_apps                  */
/* ------------------------------------------------------------------ */

test("a transfer to another team also needs manage_env - the variables travel with it", async () => {
  await assert.rejects(
    () => asMover(() => transferAppToTeam(APP, TEAM_B)),
    /permission/i,
    "move_apps alone must not carry an app's secrets into another team",
  );
  assert.equal((await placementOf()).teamId, TEAM_A);

  await setCaps(["move_apps", "manage_env"]);
  await asMover(() => transferAppToTeam(APP, TEAM_B));
  assert.equal((await placementOf()).teamId, TEAM_B, "with both, the app lands in the other team");
});

test("a team the mover doesn't belong to is not a destination", async () => {
  await setCaps(["move_apps", "manage_env"]);
  await pg.exec(`delete from memberships where id = 'mem_mover_b';`);
  await assert.rejects(
    () => asMover(() => transferAppToTeam(APP, TEAM_B)),
    /not a member/i,
  );
  assert.equal((await placementOf()).teamId, TEAM_A);
});

test("the transfer picker offers exactly the teams the mover may move INTO", async () => {
  await setCaps(["move_apps", "manage_env"]);
  const info = await asMover(() => appTransferInfo(APP));
  assert.deepEqual(
    info.targets.map((t) => t.id),
    [TEAM_B],
    "only the other team the mover holds move_apps in",
  );
});
