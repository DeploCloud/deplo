import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  seedApp,
  seedDeployment,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { listDeployments, rollbackDeployment } from "./deployments";
import { loadDeploymentsForApp } from "./app-graph-load";

/**
 * Rollback, at the data layer: which deployments an app can be put back on, and
 * every way a target that LOOKS eligible is not.
 *
 * The window is the interesting part. It has to line up with what the app's
 * server was told to keep (`rollback_keep` + the running one), because Deplo
 * pushes to no registry - offering a rollback whose image was pruned is offering
 * a deploy that cannot work.
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

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

/** `<n>` minutes before a fixed base, so "newest first" is unambiguous. */
const at = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000).toISOString();

/** One app with `count` successful builds, newest first: dpl_0 is live. */
async function seedBuilds(count: number, rollbackKeep = 3) {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web", rollbackKeep });
  for (let i = 0; i < count; i++) {
    await seedDeployment(db, {
      id: `dpl_${i}`,
      appId: "prj_1",
      status: "ready",
      createdAt: at(i),
      serverId: SERVER_1,
      imageRef: `deplo/web:dpl_${i}`,
    });
  }
}

const rollbackable = async () =>
  (await asUser1(() => listDeployments({ appId: "prj_1" })))
    .filter((d) => d.canRollback)
    .map((d) => d.id);

test("the live build is not a rollback target, the ones behind it are", async () => {
  await seedBuilds(3);
  // dpl_0 is what the container is running - going "back" to it is a no-op.
  assert.deepEqual(await rollbackable(), ["dpl_1", "dpl_2"]);
});

test("the window is rollback_keep deep, and nothing older is offered", async () => {
  // Six builds, keep 2: the live one plus two behind it are on the host.
  await seedBuilds(6, 2);
  assert.deepEqual(await rollbackable(), ["dpl_1", "dpl_2"]);
});

test("rollback_keep 0 turns the feature off for that app", async () => {
  await seedBuilds(4, 0);
  assert.deepEqual(await rollbackable(), []);
});

test("a deployment with no image of ours is never a target", async () => {
  // What a compose stack or a prebuilt `docker-image` source leaves behind: a
  // successful deployment that minted nothing this host can re-run.
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await seedDeployment(db, { id: "dpl_0", appId: "prj_1", createdAt: at(0), serverId: SERVER_1 });
  await seedDeployment(db, { id: "dpl_1", appId: "prj_1", createdAt: at(1), serverId: SERVER_1 });
  assert.deepEqual(await rollbackable(), []);
});

test("only a build that SUCCEEDED is a target", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await seedDeployment(db, {
    id: "dpl_live",
    appId: "prj_1",
    status: "ready",
    createdAt: at(0),
    serverId: SERVER_1,
    imageRef: "deplo/web:dpl_live",
  });
  for (const [id, status] of [
    ["dpl_err", "error"],
    ["dpl_cancel", "canceled"],
    ["dpl_building", "building"],
  ] as const) {
    await seedDeployment(db, {
      id,
      appId: "prj_1",
      status,
      createdAt: at(1),
      serverId: SERVER_1,
      imageRef: `deplo/web:${id}`,
    });
  }
  assert.deepEqual(await rollbackable(), []);
});

test("a preview build is never a target", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await seedDeployment(db, {
    id: "dpl_live",
    appId: "prj_1",
    status: "ready",
    createdAt: at(0),
    serverId: SERVER_1,
    imageRef: "deplo/web:dpl_live",
  });
  await seedDeployment(db, {
    id: "dpl_pr",
    appId: "prj_1",
    status: "ready",
    environment: "preview",
    deployKey: "web__pr-7",
    prNumber: 7,
    createdAt: at(1),
    serverId: SERVER_1,
    imageRef: "deplo/web__pr-7:dpl_pr",
  });
  assert.deepEqual(await rollbackable(), []);
});

test("a build from ANOTHER server is not a target - its image stayed there", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await seedDeployment(db, {
    id: "dpl_live",
    appId: "prj_1",
    status: "ready",
    createdAt: at(0),
    serverId: SERVER_1,
    imageRef: "deplo/web:dpl_live",
  });
  await seedDeployment(db, {
    id: "dpl_old_host",
    appId: "prj_1",
    status: "ready",
    createdAt: at(1),
    serverId: "srv_elsewhere",
    imageRef: "deplo/web:dpl_old_host",
  });
  assert.deepEqual(await rollbackable(), []);
});

test("rolling back re-runs the target's image and records what it went back to", async () => {
  await seedBuilds(3);
  const dep = await asUser1(() => rollbackDeployment("dpl_2"));

  assert.equal(dep.rollbackOf, "dpl_2");
  // The IMAGE is the target's, not a new one - that is the whole feature.
  assert.equal(dep.imageRef, "deplo/web:dpl_2");
  assert.equal(dep.status, "queued");
  assert.equal(dep.environment, "production");
});

test("a queued rollback has not moved the live image yet", async () => {
  await seedBuilds(3, 2);
  await asUser1(() => rollbackDeployment("dpl_2"));
  // Still dpl_0 running until the deploy lands, so the offer is unchanged - the
  // window must follow what the container HAS, not what it was asked to become.
  assert.deepEqual(await rollbackable(), ["dpl_1", "dpl_2"]);
});

test("a rollback row occupies no retention slot, so rolling FORWARD still works", async () => {
  await seedBuilds(3, 2);
  const back = await asUser1(() => rollbackDeployment("dpl_2"));
  // What the deploy pipeline writes when the stack comes up (commitOutcome).
  await pg.exec(
    `update deployments set status = 'ready' where id = '${back.id}';`,
  );

  // dpl_2's image is live now, so it drops off; dpl_0 and dpl_1 are the way back
  // up. If the rollback row had counted as a build, the window would have slid by
  // one and dpl_1 would have vanished with nothing having been built.
  assert.deepEqual(await rollbackable(), ["dpl_0", "dpl_1"]);
  // And the rollback row itself is never a target: it built no image.
  const rows = await asUser1(() => listDeployments({ appId: "prj_1" }));
  assert.equal(rows.find((d) => d.rollbackOf === "dpl_2")?.canRollback, false);
});

test("rolling back to the running deployment is refused as a no-op", async () => {
  await seedBuilds(3);
  await assert.rejects(
    () => asUser1(() => rollbackDeployment("dpl_0")),
    /already running/i,
  );
});

test("a target outside the window is refused, and says how to keep more", async () => {
  await seedBuilds(6, 2);
  await assert.rejects(
    () => asUser1(() => rollbackDeployment("dpl_5")),
    /no longer kept on the server/i,
  );
});

test("a failed build is refused by name, not by the window", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await seedDeployment(db, {
    id: "dpl_err",
    appId: "prj_1",
    status: "error",
    createdAt: at(1),
    serverId: SERVER_1,
    imageRef: "deplo/web:dpl_err",
  });
  await assert.rejects(
    () => asUser1(() => rollbackDeployment("dpl_err")),
    /finished successfully/i,
  );
});

test("a deployment of another team's app is not found, not refused", async () => {
  await seedBuilds(3);
  // Same answer as a nonexistent id: a cross-team caller learns nothing about
  // whether the deployment exists.
  await assert.rejects(
    () =>
      runWithIdentity({ userId: "user_2", teamId: TEAM_B }, () =>
        rollbackDeployment("dpl_1"),
      ),
    /not found/i,
  );
  // …and nothing was queued for it.
  assert.equal((await loadDeploymentsForApp("prj_1")).length, 3);
});

test("a member without rollback_apps cannot roll back", async () => {
  await seedBuilds(3);
  await pg.exec(
    `delete from membership_capabilities where capability = 'rollback_apps';`,
  );
  await assert.rejects(
    () => asUser1(() => rollbackDeployment("dpl_1")),
    /permission|capability|rollback/i,
  );
});
