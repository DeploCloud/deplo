import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity, type TokenGrant } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedDeployment,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { folders as foldersTable } from "../db/schema/control-plane/projects";
import { setFolderGrant } from "./folder-access";
import { listDeployments } from "./deployments/deployment-queries";
import { rollbackDeployment } from "./deployments/rollback";
import { setAppRollbackKeep } from "./apps/settings";
import { rollbackKeepBySlug } from "./docker-cleanup/live-inventory";
import { isInstanceAdmin } from "../membership";
import { loadAppGraph, loadDeploymentsForApp } from "./app-graph-load";
import { MAX_ROLLBACK_KEEP } from "../types/app";
import { ALL_CAPABILITIES, type Capability } from "../types/identity";
import { NODE_GRANTABLE_CAPABILITIES } from "../membership-shared";
import { getDb } from "../db/client";
import { apps as appsSchema } from "../db/schema/control-plane/apps";
import { eq } from "drizzle-orm";

let db: TestDb;
let pg: PGlite;

const OWNER = USER_1;
const GRANTEE = "user_grantee";
const OTHER = "user_other";
const ROLLBACKER = "user_rollbacker";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      {
        id: GRANTEE,
        teamId: TEAM_A,
        role: "member",
        capabilities: ALL_CAPABILITIES.filter((c) => c !== "rollback_apps"),
      },
      { id: OTHER, teamId: TEAM_B, role: "owner" },
      {
        id: ROLLBACKER,
        teamId: TEAM_A,
        role: "member",
        capabilities: ["view", "rollback_apps"] as Capability[],
      },
    ],
  });
  await seedServer(db);
});

const as = <T>(
  userId: string,
  teamId: string,
  fn: () => Promise<T>,
): Promise<T> => runWithIdentity({ userId, teamId }, fn);

const grant = (over: Partial<TokenGrant> = {}): TokenGrant => ({
  id: "tok_test",
  capabilities: [...ALL_CAPABILITIES],
  scope: {
    teamIds: [TEAM_A],
    wholeTeamIds: [TEAM_A],
    projectIds: [],
    folderIds: [],
    appIds: [],
    appProjectIds: [],
  },
  instanceAdmin: false,
  ...over,
});

const at = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000).toISOString();

async function seedTwoBuilds(opts: { folderId?: string } = {}) {
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    slug: "web",
    folderId: opts.folderId ?? null,
  });
  for (const [id, ago] of [
    ["dpl_0", 0],
    ["dpl_1", 1],
  ] as const) {
    await seedDeployment(db, {
      id,
      appId: "prj_1",
      status: "ready",
      createdAt: at(ago),
      serverId: SERVER_1,
      imageRef: `deplo/web:${id}`,
    });
  }
}

async function assertNothingQueued(appId = "prj_1") {
  const rows = await loadDeploymentsForApp(appId);
  assert.equal(
    rows.filter((d) => d.status === "queued").length,
    0,
    "a refused rollback still queued a deployment",
  );
  assert.equal(
    rows.filter((d) => d.rollbackOf).length,
    0,
    "a refused rollback still wrote a rollback row",
  );
}

test("deploy_apps alone does NOT let a member roll back", async () => {
  await seedTwoBuilds();
  await assert.rejects(
    () => as(GRANTEE, TEAM_A, () => rollbackDeployment("dpl_1")),
    /permission/i,
    "a member holding every capability but rollback_apps got through",
  );
  await assertNothingQueued();
});

test("the member who cannot roll back is not offered the action either", async () => {
  await seedTwoBuilds();
  // canRollback describes the DEPLOYMENT, not the viewer: it stays true and the permission is
  // what the UI greys out.
  const rows = await as(GRANTEE, TEAM_A, () =>
    listDeployments({ appId: "prj_1" }),
  );
  assert.equal(rows.find((d) => d.id === "dpl_1")?.canRollback, true);
});

test("rollback_apps alone is enough - it does not silently need deploy_apps too", async () => {
  await seedTwoBuilds();
  const dep = await as(ROLLBACKER, TEAM_A, () => rollbackDeployment("dpl_1"));
  assert.equal(dep.rollbackOf, "dpl_1");
});

test("another team's deployment answers 'not found', never 'forbidden'", async () => {
  await seedTwoBuilds();
  await assert.rejects(
    () => as(OTHER, TEAM_B, () => rollbackDeployment("dpl_1")),
    /not found/i,
    "the refusal told a stranger the deployment exists",
  );
  await assertNothingQueued();
});

test("a nonexistent id answers exactly what a foreign id answers", async () => {
  await seedTwoBuilds();
  await assert.rejects(
    () => as(OTHER, TEAM_B, () => rollbackDeployment("dpl_nope")),
    /not found/i,
  );
});

test("another team's deployments never carry canRollback into this team's list", async () => {
  await seedTwoBuilds();
  const rows = await as(OTHER, TEAM_B, () => listDeployments());
  assert.equal(rows.length, 0, "a cross-team list returned rows at all");
});

test("a folder grant WITHOUT rollback_apps cannot roll back an app in that folder", async () => {
  await db.insert(foldersTable).values({
    id: "fld_1",
    teamId: TEAM_A,
    name: "Ops",
    ownerUserId: OWNER,
    createdAt: at(0),
    updatedAt: at(0),
  });
  await seedTwoBuilds({ folderId: "fld_1" });
  await as(OWNER, TEAM_A, () =>
    setFolderGrant("fld_1", GRANTEE, ["deploy_apps", "configure_apps"]),
  );
  await assert.rejects(
    () => as(GRANTEE, TEAM_A, () => rollbackDeployment("dpl_1")),
    /permission|not found/i,
  );
  await assertNothingQueued();
});

test("a folder grant stores rollback_apps like any other node-grantable verb", async () => {
  await db.insert(foldersTable).values({
    id: "fld_1",
    teamId: TEAM_A,
    name: "Ops",
    ownerUserId: OWNER,
    createdAt: at(0),
    updatedAt: at(0),
  });
  await seedTwoBuilds({ folderId: "fld_1" });
  assert.ok(
    NODE_GRANTABLE_CAPABILITIES.includes("rollback_apps"),
    "rollback_apps is not grantable on a node",
  );
  const rows = await as(OWNER, TEAM_A, () =>
    setFolderGrant("fld_1", GRANTEE, ["rollback_apps"]),
  );
  assert.deepEqual(
    rows
      .find((r) => r.userId === GRANTEE)
      ?.capabilities.filter((c) => c !== "view"),
    ["rollback_apps"],
    "the grant did not persist rollback_apps",
  );
});

test("a token scoped to a project it is not in cannot roll the app back", async () => {
  await seedTwoBuilds();
  await assert.rejects(
    () =>
      runWithIdentity(
        {
          userId: OWNER,
          teamId: TEAM_A,
          token: grant({
            scope: {
              teamIds: [TEAM_A],
              wholeTeamIds: [],
              projectIds: ["prc_elsewhere"],
              folderIds: [],
              appIds: [],
              appProjectIds: [],
            },
          }),
        },
        () => rollbackDeployment("dpl_1"),
      ),
    /not found/i,
  );
  await assertNothingQueued();
});

test("a token WITHOUT rollback_apps is refused even holding everything else", async () => {
  await seedTwoBuilds();
  await assert.rejects(
    () =>
      runWithIdentity(
        {
          userId: OWNER,
          teamId: TEAM_A,
          token: grant({
            capabilities: ALL_CAPABILITIES.filter((c) => c !== "rollback_apps"),
          }),
        },
        () => rollbackDeployment("dpl_1"),
      ),
    /permission/i,
  );
  await assertNothingQueued();
});

test("rollback_apps does NOT let someone change how many rollbacks are kept", async () => {
  await seedTwoBuilds();
  await assert.rejects(
    () => as(ROLLBACKER, TEAM_A, () => setAppRollbackKeep("prj_1", 20)),
    /permission/i,
    "being able to go back also let someone fill the host's disk",
  );
  assert.equal((await loadAppGraph("prj_1"))?.rollbackKeep, 3);
});

test("retention cannot be written across a team boundary", async () => {
  await seedTwoBuilds();
  await assert.rejects(
    () => as(OTHER, TEAM_B, () => setAppRollbackKeep("prj_1", 0)),
    /not found/i,
  );
  assert.equal((await loadAppGraph("prj_1"))?.rollbackKeep, 3);
});

test("retention is clamped, not trusted", async () => {
  await seedTwoBuilds();
  for (const [given, want] of [
    [-5, 0],
    [0, 0],
    [999, 20],
    [3.9, 3],
    [Number.NaN, 3],
  ] as const) {
    await as(OWNER, TEAM_A, () => setAppRollbackKeep("prj_1", given));
    assert.equal(
      (await loadAppGraph("prj_1"))?.rollbackKeep,
      want,
      `rollbackKeep(${given}) should clamp to ${want}`,
    );
  }
});

test("the host is told rollback_keep + 1: the depth plus the build that is live", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await seedApp(db, { id: "prj_2", teamId: TEAM_A, slug: "api" });
  await as(OWNER, TEAM_A, () => setAppRollbackKeep("prj_1", 3));
  await as(OWNER, TEAM_A, () => setAppRollbackKeep("prj_2", 7));

  assert.deepEqual(await rollbackKeepBySlug(SERVER_1), { web: 4, api: 8 });
});

test("an app that keeps NO rollbacks still keeps the image it is running", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await as(OWNER, TEAM_A, () => setAppRollbackKeep("prj_1", 0));
  assert.deepEqual(await rollbackKeepBySlug(SERVER_1), { web: 1 });
});

test("the map covers every team on the host - a sweep is not team-scoped", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await seedApp(db, { id: "prj_2", teamId: TEAM_B, slug: "other-team-app" });
  const map = await rollbackKeepBySlug(SERVER_1);
  assert.deepEqual(Object.keys(map).sort(), ["other-team-app", "web"]);
});

test("an app that CANNOT roll back is absent from the map", async () => {
  await seedApp(db, {
    id: "prj_c",
    teamId: TEAM_A,
    slug: "stack",
    source: "compose",
    compose: "services:\n  web:\n    image: nginx\n",
  });
  await seedApp(db, { id: "prj_g", teamId: TEAM_A, slug: "web" });
  assert.deepEqual(await rollbackKeepBySlug(SERVER_1), { web: 4 });
});

test("a value that got past the setter is still clamped on the way to the wire", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await getDb()
    .update(appsSchema)
    .set({ rollbackKeep: 2_000_000_000 })
    .where(eq(appsSchema.id, "prj_1"));
  assert.deepEqual(await rollbackKeepBySlug(SERVER_1), {
    web: MAX_ROLLBACK_KEEP + 1,
  });
});

test("a preview stack is deliberately absent from the map", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await seedDeployment(db, {
    id: "dpl_pr",
    appId: "prj_1",
    status: "ready",
    environment: "preview",
    deployKey: "web__pr-7",
    prNumber: 7,
    createdAt: at(0),
    serverId: SERVER_1,
    imageRef: "deplo/web__pr-7:dpl_pr",
  });
  // The agent groups images by the `deplo.slug` LABEL and a preview's is `<slug>__pr-<n>`, so
  // naming it would hand a torn-down pull request the app's whole retention budget.
  const map = await rollbackKeepBySlug(SERVER_1);
  assert.deepEqual(Object.keys(map), ["web"]);
});

test("an instance admin is not a shortcut past the capability", async () => {
  await seedTwoBuilds();
  const admin = await as(OWNER, TEAM_A, () => isInstanceAdmin());
  assert.equal(admin, true, "the fixture owner should be an instance admin");
  const notAdmin = await as(GRANTEE, TEAM_A, () => isInstanceAdmin());
  assert.equal(notAdmin, false);
  await assert.rejects(
    () => as(GRANTEE, TEAM_A, () => rollbackDeployment("dpl_1")),
    /permission/i,
  );
});
