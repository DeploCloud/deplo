import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apps, appPorts, appVolumes } from "../../db/schema/control-plane/apps";
import { runWithIdentity } from "../../auth/request-context";
import { REPLICAS_DATA_MESSAGE } from "../../deploy/replicas";
import { seedIdentity, TEAM_A, TEAM_B } from "../identity-test-helpers";
import {
  TRUNCATE_PROJECT_GRAPH,
  seedApp,
  seedServer,
} from "../app-graph-test-helpers";
import { setAppReplicas, setAppStickySessions } from "./settings";

let db: TestDb;
let pg: PGlite;
const OWNER = "u_owner";
const VIEWER = "u_viewer";
const STRANGER = "u_stranger";
const APP = "prj_web";

const as = <T>(userId: string, teamId: string, fn: () => Promise<T>) =>
  runWithIdentity({ userId, teamId }, fn);
const set = (n: number) => as(OWNER, TEAM_A, () => setAppReplicas(APP, n));
const replicas = async () =>
  (await db.select().from(apps).where(eq(apps.id, APP)))[0].replicas;
const refused = (e: Error) => e.message === REPLICAS_DATA_MESSAGE;

const volume = (type: string | null) => ({
  appId: APP,
  position: 0,
  volumeId: "vol_0",
  type,
  name: "data",
  mountPath: "/data",
  readOnly: false,
});

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
  await pg.exec(
    `truncate table membership_capabilities, memberships, users, teams restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: OWNER, teamId: TEAM_A, role: "owner" },
      { id: VIEWER, teamId: TEAM_A, role: "member", capabilities: ["view"] },
      { id: STRANGER, teamId: TEAM_B, role: "owner" },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: APP, teamId: TEAM_A, slug: "web" });
  await db
    .update(apps)
    .set({ source: "docker-image", dockerImage: "nginx:1.27", compose: null })
    .where(eq(apps.id, APP));
});

test("an app runs one copy until someone sets more", async () => {
  assert.equal(await replicas(), 1);
  await set(3);
  assert.equal(await replicas(), 3);
  await set(1);
  assert.equal(await replicas(), 1);
});

test("the count is validated in the data layer", async () => {
  for (const n of [0, 11, 2.5]) await assert.rejects(set(n), /1 to 10/);
  assert.equal(await replicas(), 1);
});

test("a Volume or a Bind refuses more than one copy", async () => {
  for (const type of ["named", "host"]) {
    await db.insert(appVolumes).values(volume(type));
    await assert.rejects(set(2), refused);
    await db.delete(appVolumes);
  }
  assert.equal(await replicas(), 1);
});

test("a published host port refuses more than one copy, and one copy stays allowed", async () => {
  await db.insert(appPorts).values({
    portId: "prt_1",
    appId: APP,
    published: 25565,
    target: 25565,
    protocol: "tcp",
    position: 0,
  });
  await assert.rejects(set(2), refused);
  await set(1);
  assert.equal(await replicas(), 1);
});

test("Files do not block replicas", async () => {
  await db
    .insert(appVolumes)
    .values({ ...volume("app"), projectPath: "conf/app.yml" });
  await set(4);
  assert.equal(await replicas(), 4);
});

test("a compose stack sets replicas in its own YAML", async () => {
  await db
    .update(apps)
    .set({
      source: "compose",
      dockerImage: null,
      compose: "services:\n  a:\n    image: x\n",
    })
    .where(eq(apps.id, APP));
  await assert.rejects(set(2), /own YAML/);
});

test("only a member who may configure the app sets it", async () => {
  await assert.rejects(
    as(VIEWER, TEAM_A, () => setAppReplicas(APP, 2)),
    /permission/,
  );
  assert.equal(await replicas(), 1);
});

test("another team's app is out of reach", async () => {
  await assert.rejects(as(STRANGER, TEAM_B, () => setAppReplicas(APP, 2)));
  assert.equal(await replicas(), 1);
});

const sticky = async () =>
  (await db.select().from(apps).where(eq(apps.id, APP)))[0].stickySessions;

test("sticky sessions are off until someone turns them on with more than one copy", async () => {
  assert.equal(await sticky(), false);
  await assert.rejects(
    as(OWNER, TEAM_A, () => setAppStickySessions(APP, true)),
    /more than one/,
  );
  await set(2);
  await as(OWNER, TEAM_A, () => setAppStickySessions(APP, true));
  assert.equal(await sticky(), true);
  await as(OWNER, TEAM_A, () => setAppStickySessions(APP, false));
  assert.equal(await sticky(), false);
});

test("only a member who may configure the app sets sticky sessions", async () => {
  await set(2);
  await assert.rejects(
    as(VIEWER, TEAM_A, () => setAppStickySessions(APP, true)),
    /permission/,
  );
  await assert.rejects(
    as(STRANGER, TEAM_B, () => setAppStickySessions(APP, true)),
  );
  assert.equal(await sticky(), false);
});
