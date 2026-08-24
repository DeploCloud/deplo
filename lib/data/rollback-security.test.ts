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
import { folders as foldersTable } from "../db/schema/control-plane";
import { setFolderGrant } from "./folder-access";
import { listDeployments, rollbackDeployment } from "./deployments";
import { setAppRollbackKeep } from "./apps";
import { rollbackKeepBySlug } from "./docker-cleanup";
import { isInstanceAdmin } from "../membership";
import { loadAppGraph, loadDeploymentsForApp } from "./app-graph-load";
import { ALL_CAPABILITIES, MAX_ROLLBACK_KEEP, type Capability } from "../types";
import { NODE_GRANTABLE_CAPABILITIES } from "../membership-shared";
import { getDb } from "../db/client";
import { apps as appsSchema } from "../db/schema/control-plane";
import { eq } from "drizzle-orm";

/**
 * Rollback as an ATTACKER sees it.
 *
 * The feature puts production back on an older build, so every one of its gates
 * is load-bearing: the permission that allows it, the team the app belongs to,
 * the folder it sits in, and the scope of the token asking. Each test here tries
 * to reach a rollback the caller should not have, and the assertion is that it
 * fails AND that nothing was queued as a side effect - a refusal that still
 * enqueued the deploy would be the worst of both.
 */

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
      // Holds everything EXCEPT rollback_apps: the control that proves the two
      // permissions are genuinely separate rather than one wearing two names.
      {
        id: GRANTEE,
        teamId: TEAM_A,
        role: "member",
        capabilities: ALL_CAPABILITIES.filter((c) => c !== "rollback_apps"),
      },
      { id: OTHER, teamId: TEAM_B, role: "owner" },
      // Holds ONLY the rollback verb: the mirror control, proving it does not
      // quietly need deploy_apps (or anything else) beside it.
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

/** Two successful builds of one app: dpl_0 live, dpl_1 the rollback target. */
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

/** Nothing was enqueued: a refusal must not leave a deploy behind. */
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

/* ------------------------------------------------------------------ */
/* The permission itself                                               */
/* ------------------------------------------------------------------ */

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
  // canRollback describes the DEPLOYMENT, not the viewer - it stays true, and the
  // permission is what the UI greys out. What must not happen is the reverse: a
  // list that hides it while the server would allow it, or vice versa.
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

/* ------------------------------------------------------------------ */
/* Team, folder and token boundaries                                   */
/* ------------------------------------------------------------------ */

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
  // Everything a deployer needs, deliberately minus the one verb under test.
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
  // The write site bounds a grant to NODE_GRANTABLE_CAPABILITIES; a verb missing
  // from that list is silently dropped, which would make the folder Share dialog
  // offer a permission it cannot actually save.
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
  // The app sits at the team top level; the token is confined to a project, so
  // the app is out of its reach even though it holds every capability.
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

/* ------------------------------------------------------------------ */
/* The retention setting is a DIFFERENT permission                     */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* What the HOST is actually told to keep                              */
/* ------------------------------------------------------------------ */

/**
 * The map the sweep sends is the only thing standing between a rollback target
 * and `docker rmi`. Its arithmetic is off-by-one bait: "keep 3 rollbacks" means
 * three builds to go BACK to, and the one running is not one of them - so the
 * host has to be told 4. One short and every app silently loses its oldest
 * rollback, which nobody notices until they reach for it.
 */
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
  // 1, never 0: a stopped app has to stay startable without a rebuild, which is
  // the same floor the agent applies to the scalar.
  assert.deepEqual(await rollbackKeepBySlug(SERVER_1), { web: 1 });
});

test("the map covers every team on the host - a sweep is not team-scoped", async () => {
  // One host, two teams. A map built per-team would hand the agent a partial
  // picture and let it prune the other team's rollbacks.
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await seedApp(db, { id: "prj_2", teamId: TEAM_B, slug: "other-team-app" });
  const map = await rollbackKeepBySlug(SERVER_1);
  assert.deepEqual(Object.keys(map).sort(), ["other-team-app", "web"]);
});

test("an app that CANNOT roll back is absent from the map", async () => {
  // Naming a compose stack would hold four images per built SERVICE on the host in
  // exchange for a button that is never offered - the feature's disk cost with
  // none of its benefit. It falls back to the instance scalar instead.
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
  // The column carries no CHECK and the proto field is an int32, so a value that
  // arrived some other way must not ride out as-is.
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
  // The agent groups images by the deplo.slug LABEL, and a preview's is
  // `<slug>__pr-<n>`. Naming it would hand a torn-down pull request the app's
  // whole retention budget.
  const map = await rollbackKeepBySlug(SERVER_1);
  assert.deepEqual(Object.keys(map), ["web"]);
});

/* ------------------------------------------------------------------ */
/* Instance admin                                                      */
/* ------------------------------------------------------------------ */

test("an instance admin is not a shortcut past the capability", async () => {
  await seedTwoBuilds();
  // GRANTEE holds everything but rollback_apps. Being an instance admin must not
  // change that answer, because the UI enables the button on `|| isAdmin` (the
  // house pattern for redeploy and delete) and the server is the real gate.
  const admin = await as(OWNER, TEAM_A, () => isInstanceAdmin());
  assert.equal(admin, true, "the fixture owner should be an instance admin");
  const notAdmin = await as(GRANTEE, TEAM_A, () => isInstanceAdmin());
  assert.equal(notAdmin, false);
  await assert.rejects(
    () => as(GRANTEE, TEAM_A, () => rollbackDeployment("dpl_1")),
    /permission/i,
  );
});
