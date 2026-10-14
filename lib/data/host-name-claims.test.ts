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
import { appVolumes as appVolumesTable } from "../db/schema/control-plane/apps";
import { pendingTeardowns as pendingTeardownsTable } from "../db/schema/control-plane/deployments";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { seedDatabase, settleProvisioning } from "./backup-test-helpers";
import { createApp } from "./apps/create";
import { setAppVolumes } from "./apps/volumes";
import { createDatabase } from "./databases/provision";
import { updateDatabase } from "./databases/server-move";
import type { VolumeMount } from "../types/container";

let db: TestDb;
let pg: PGlite;
let agentDialed: string[] = [];

const T0 = "2026-01-01T00:00:00.000Z";

const asA = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asB = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: "user_2", teamId: TEAM_B }, fn);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  await settleProvisioning(db);
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await settleProvisioning(db);
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table databases, pending_teardowns, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_2", teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db, SERVER_1, { provisioned: true });
  await seedServer(db, "srv_2", { provisioned: true });
  agentDialed = [];
  __setAgentConnectorForTest(async (id) => {
    agentDialed.push(id);
    throw new Error("no agent in this test");
  });
});

async function seedVolume(appId: string, name: string): Promise<void> {
  await db.insert(appVolumesTable).values({
    appId,
    position: 0,
    volumeId: `vol_${appId}_${name}`,
    type: null,
    name,
    service: null,
    projectPath: null,
    hostPath: null,
    mountPath: `/${name}`,
    readOnly: false,
    propagation: null,
  });
}

const vol = (name: string, mountPath: string, id = ""): VolumeMount => ({
  id,
  name,
  mountPath,
  readOnly: false,
});

const app = (name: string) => ({
  name,
  source: "compose" as const,
  repo: null,
  compose: `services:\n  ${name.replace(/\W/g, "")}:\n    image: nginx:1.27\n`,
  deploy: false,
});

test("a new volume cannot reach into a longer app's names", async () => {
  await seedApp(db, { id: "prj_a", teamId: TEAM_A, slug: "my-app" });
  await seedVolume("prj_a", "data");
  await seedApp(db, { id: "prj_b", teamId: TEAM_B, slug: "my" });

  for (const name of ["app-data", "app_data"])
    await asB(() =>
      assert.rejects(
        setAppVolumes("prj_b", [vol(name, "/data")]),
        /clashes with another app's storage/,
        name,
      ),
    );
  await asB(() => setAppVolumes("prj_b", [vol("logs", "/l")]));
  await asA(() =>
    setAppVolumes("prj_a", [
      vol("data", "/data", "vol_prj_a_data"),
      vol("cache", "/cache"),
    ]),
  );
});

test("an exact twin is refused, and a volume an app already holds keeps saving", async () => {
  await seedApp(db, { id: "prj_b", teamId: TEAM_B, slug: "my" });
  await seedVolume("prj_b", "app-data");
  await seedApp(db, { id: "prj_a", teamId: TEAM_A, slug: "my-app" });

  await asA(() =>
    assert.rejects(setAppVolumes("prj_a", [vol("data", "/data")]), /clashes/),
  );
  await asB(() =>
    setAppVolumes("prj_b", [
      vol("app-data", "/app-data", "vol_prj_b_app-data"),
      vol("logs", "/logs"),
    ]),
  );
});

test("a new app's slug steps around a database's stack and other apps' volume names", async () => {
  await seedDatabase(db, {
    id: "db_b",
    teamId: TEAM_B,
    name: "main",
    serverId: "srv_2",
  });
  await seedApp(db, { id: "prj_my", teamId: TEAM_B, slug: "my" });
  await seedVolume("prj_my", "shop_data");
  await seedApp(db, { id: "prj_api", teamId: TEAM_B, slug: "web-api" });
  await seedVolume("prj_api", "data");

  assert.equal((await asA(() => createApp(app("db-main")))).slug, "db-main-1");
  assert.equal((await asA(() => createApp(app("my shop")))).slug, "my-shop-1");
  assert.equal(
    (await asA(() => createApp(app("web")))).slug,
    "web",
    "a shorter slug over a longer app's names is fine",
  );
});

test("a new database never takes an app's name or sits under its volumes", async () => {
  await seedApp(db, { id: "prj_shop", teamId: TEAM_B, slug: "db-shop" });
  await seedApp(db, { id: "prj_db", teamId: TEAM_B, slug: "db" });
  await seedVolume("prj_db", "main_db-main-data");
  for (const name of ["shop", "main"])
    await asA(() =>
      assert.rejects(
        createDatabase({
          name,
          type: "postgres",
          version: "16",
          serverId: SERVER_1,
        }),
        new RegExp(`An app already uses the name "db-${name}"`),
      ),
    );
  assert.deepEqual(agentDialed, []);
});

test("a database move refuses a server where its stack name is taken", async () => {
  await seedDatabase(db, {
    id: "db_b",
    teamId: TEAM_B,
    name: "main",
    serverId: "srv_2",
  });
  await seedDatabase(db, { id: "db_a", name: "main", serverId: SERVER_1 });
  await seedDatabase(db, { id: "db_o", name: "other", serverId: SERVER_1 });
  await db.insert(pendingTeardownsTable).values({
    id: "ptd_other",
    serverId: "srv_2",
    deployKey: "db-other",
    projectLabel: "db_gone",
    label: "other",
    teamId: TEAM_B,
    nextAttemptAt: T0,
    createdAt: T0,
  });

  await asA(async () => {
    await assert.rejects(
      updateDatabase("db_a", { exposedPublicly: false, serverId: "srv_2" }),
      /cannot move to srv_2: a database stack named "db-main" already exists/,
    );
    await assert.rejects(
      updateDatabase("db_o", { exposedPublicly: false, serverId: "srv_2" }),
      /"db-other" is still being removed/,
    );
  });
  assert.deepEqual(agentDialed, [], "refused before any server is touched");
});
