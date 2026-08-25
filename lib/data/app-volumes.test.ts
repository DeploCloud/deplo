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
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { setAppVolumes } from "./apps";
import { loadAppGraph } from "./app-graph-load";
import { buildComposeStack } from "../deploy/compose-stack";
import type { VolumeMount } from "../types";

/**
 * Storage volumes on a COMPOSE-STACK app — the writer that used to refuse them
 * outright ("volumes are managed inside the compose file"), which forced anyone on
 * a compose app to hand-edit YAML for something as ordinary as persistent uploads.
 */

const COMPOSE = `services:
  web:
    image: nginx
    ports:
      - "8080:80"
  db:
    image: postgres
`;

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

const vol = (v: Partial<VolumeMount>): VolumeMount => ({
  id: "",
  name: "data",
  mountPath: "/data",
  readOnly: false,
  ...v,
});

test("a compose-stack app can save volumes (no longer refused)", async () => {
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    source: "compose",
    compose: COMPOSE,
  });
  await asUser1(() =>
    setAppVolumes("prj_1", [
      vol({
        name: "pgdata",
        service: "db",
        mountPath: "/var/lib/postgresql/data",
      }),
    ]),
  );
  const app = await loadAppGraph("prj_1");
  assert.equal(app?.volumes?.length, 1);
  assert.equal(app!.volumes![0].name, "pgdata");
  assert.equal(app!.volumes![0].service, "db");
});

test("the saved volume reaches the rendered stack, on its own service", async () => {
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    slug: "shop",
    source: "compose",
    compose: COMPOSE,
  });
  await asUser1(() =>
    setAppVolumes("prj_1", [
      vol({ name: "uploads", service: "web", mountPath: "/app/uploads" }),
    ]),
  );
  const app = (await loadAppGraph("prj_1"))!;
  const yamlOut = buildComposeStack({
    compose: app.compose ?? "",
    name: "deplo-shop",
    deployKey: app.slug,
    appId: app.id,
    domainRoutes: [],
    volumes: app.volumes,
  });
  assert.match(yamlOut, /uploads:\/app\/uploads/);
  assert.match(yamlOut, /name: deplo-shop-uploads/);
});

test("a compose service the file does not declare is refused at save time", async () => {
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    source: "compose",
    compose: COMPOSE,
  });
  await assert.rejects(
    asUser1(() => setAppVolumes("prj_1", [vol({ service: "worker" })])),
    /not in this app's compose file/,
  );
  assert.equal((await loadAppGraph("prj_1"))?.volumes, null);
});

test("a single-container app stores no service, and still saves volumes", async () => {
  await seedApp(db, { id: "prj_1", teamId: TEAM_A });
  await asUser1(() =>
    // A service picked against a single-container app is meaningless — dropped,
    // not an error (the UI never sends one).
    setAppVolumes("prj_1", [vol({ name: "cache", service: "web" })]),
  );
  const app = await loadAppGraph("prj_1");
  assert.equal(app!.volumes![0].name, "cache");
  assert.equal(app!.volumes![0].service, undefined);
});

test("volumes are replaced as a whole set, and an empty set clears them", async () => {
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    source: "compose",
    compose: COMPOSE,
  });
  await asUser1(async () => {
    await setAppVolumes("prj_1", [
      vol({ name: "a", service: "web", mountPath: "/a" }),
      vol({ name: "b", service: "db", mountPath: "/b" }),
    ]);
    assert.equal((await loadAppGraph("prj_1"))?.volumes?.length, 2);
    await setAppVolumes("prj_1", []);
  });
  assert.equal((await loadAppGraph("prj_1"))?.volumes, null);
});

test("a host bind's propagation survives the write and the read back", async () => {
  await seedApp(db, {
    id: "prj_1",
    teamId: TEAM_A,
    source: "compose",
    compose: COMPOSE,
  });
  await asUser1(() =>
    setAppVolumes("prj_1", [
      vol({
        type: "host",
        name: "neon",
        service: "web",
        hostPath: "/srv/neon_data",
        mountPath: "/srv/neon_data",
        propagation: "rslave",
      }),
      vol({
        type: "host",
        name: "plain",
        service: "web",
        hostPath: "/srv/plain",
        mountPath: "/plain",
      }),
    ]),
  );
  const vols = (await loadAppGraph("prj_1"))!.volumes!;
  assert.equal(vols[0].propagation, "rslave");
  // NULL in the column comes back as an ABSENT key, not `null` — the renderers
  // and the dirty key both read "no propagation" from its absence.
  assert.ok(!("propagation" in vols[1]));
});

test("setAppVolumes refuses a cross-team app id", async () => {
  await seedApp(db, {
    id: "prj_b",
    teamId: TEAM_B,
    source: "compose",
    compose: COMPOSE,
  });
  await assert.rejects(
    asUser1(() => setAppVolumes("prj_b", [vol({ name: "x", service: "web" })])),
    /not found/i,
  );
  assert.equal((await loadAppGraph("prj_b"))?.volumes, null);
});
