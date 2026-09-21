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
import {
  listDeployments,
  getDeployment,
} from "./deployments/deployment-queries";
import { rollbackDeployment, rollbackTarget } from "./deployments/rollback";
import { loadDeploymentsForApp } from "./app-graph-load";
import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { eq } from "drizzle-orm";
import { readFile } from "node:fs/promises";

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

const at = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 0, 1, 12, 0, 0) - minutesAgo * 60_000).toISOString();

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
  assert.deepEqual(await rollbackable(), ["dpl_1", "dpl_2"]);
});

test("the header's Rollback aims at the newest build still on the host", async () => {
  await seedBuilds(3);
  assert.equal((await asUser1(() => rollbackTarget("prj_1")))?.id, "dpl_1");
});

test("a single build leaves the header with nothing to roll back to", async () => {
  await seedBuilds(1);
  assert.equal(await asUser1(() => rollbackTarget("prj_1")), null);
});

test("another team never gets a rollback target for this app", async () => {
  await seedBuilds(3);
  const target = await runWithIdentity(
    { userId: "user_2", teamId: TEAM_B },
    () => rollbackTarget("prj_1"),
  );
  assert.equal(target, null);
});

test("the window is rollback_keep deep, and nothing older is offered", async () => {
  await seedBuilds(6, 2);
  assert.deepEqual(await rollbackable(), ["dpl_1", "dpl_2"]);
});

test("rollback_keep 0 turns the feature off for that app", async () => {
  await seedBuilds(4, 0);
  assert.deepEqual(await rollbackable(), []);
});

test("a deployment with no image of ours is never a target", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A, slug: "web" });
  await seedDeployment(db, {
    id: "dpl_0",
    appId: "prj_1",
    createdAt: at(0),
    serverId: SERVER_1,
  });
  await seedDeployment(db, {
    id: "dpl_1",
    appId: "prj_1",
    createdAt: at(1),
    serverId: SERVER_1,
  });
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
  assert.equal(dep.imageRef, "deplo/web:dpl_2");
  assert.equal(dep.status, "queued");
  assert.equal(dep.environment, "production");
});

test("a queued rollback has not moved the live image yet", async () => {
  await seedBuilds(3, 2);
  await asUser1(() => rollbackDeployment("dpl_2"));
  assert.deepEqual(await rollbackable(), ["dpl_1", "dpl_2"]);
});

test("a rollback row occupies no retention slot, so rolling FORWARD still works", async () => {
  await seedBuilds(3, 2);
  const back = await asUser1(() => rollbackDeployment("dpl_2"));
  await pg.exec(
    `update deployments set status = 'ready' where id = '${back.id}';`,
  );

  assert.deepEqual(await rollbackable(), ["dpl_0", "dpl_1"]);
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
  await assert.rejects(
    () =>
      runWithIdentity({ userId: "user_2", teamId: TEAM_B }, () =>
        rollbackDeployment("dpl_1"),
      ),
    /not found/i,
  );
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

test("an app that has SINCE become a compose stack offers none of its old builds", async () => {
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    slug: "web",
    source: "github",
  });
  for (const [id, ago] of [
    ["dpl_0", 1],
    ["dpl_1", 2],
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
  await getDb()
    .update(appsTable)
    .set({
      source: "compose",
      compose: "services:\n  web:\n    image: nginx\n",
    })
    .where(eq(appsTable.id, "prj_1"));
  await seedDeployment(db, {
    id: "dpl_c",
    appId: "prj_1",
    status: "ready",
    createdAt: at(0),
    serverId: SERVER_1,
  });

  assert.deepEqual(await rollbackable(), []);
  await assert.rejects(
    () => asUser1(() => rollbackDeployment("dpl_0")),
    /nothing to roll back to/i,
  );
});

test("an app that has SINCE become a prebuilt image offers none of its old builds", async () => {
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    slug: "web",
    source: "github",
  });
  for (const [id, ago] of [
    ["dpl_0", 1],
    ["dpl_1", 2],
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
  await getDb()
    .update(appsTable)
    .set({
      source: "docker-image",
      dockerImage: "nginx:1.27",
      repoUrl: null,
      repoRepo: null,
    })
    .where(eq(appsTable.id, "prj_1"));
  await seedDeployment(db, {
    id: "dpl_i",
    appId: "prj_1",
    status: "ready",
    createdAt: at(0),
    serverId: SERVER_1,
  });

  assert.deepEqual(await rollbackable(), []);
});

test("the single-row read agrees with the list, over a history long enough to bound", async () => {
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    slug: "web",
    rollbackKeep: 2,
  });
  for (let i = 0; i < 40; i++) {
    await seedDeployment(db, {
      id: `dpl_${String(i).padStart(3, "0")}`,
      appId: "prj_1",
      status: "ready",
      createdAt: at(i),
      serverId: SERVER_1,
      imageRef: `deplo/web:dpl_${i}`,
    });
  }
  const listed = await asUser1(() => listDeployments({ appId: "prj_1" }));
  for (const id of ["dpl_000", "dpl_001", "dpl_002", "dpl_003", "dpl_020"]) {
    const one = await asUser1(() => getDeployment(id));
    assert.equal(
      one?.canRollback,
      listed.find((d) => d.id === id)?.canRollback,
      `${id}: the deployment page and the list disagree`,
    );
  }
  assert.deepEqual(
    listed.filter((d) => d.canRollback).map((d) => d.id),
    ["dpl_001", "dpl_002"],
  );
});

test("the alert for a rollback does not announce a new version", async () => {
  const src = (
    await Promise.all(
      ["deployment-state.ts", "deploy-run.ts"].map((f) =>
        readFile(new URL(`../deploy/build/${f}`, import.meta.url), "utf8"),
      ),
    )
  ).join("\n");
  assert.match(src, /rolled back/);
  assert.match(src, /An earlier version is live again\./);
  assert.match(src, /\{ rollback: Boolean\(dep\.rollbackOf\) \}/);
});
