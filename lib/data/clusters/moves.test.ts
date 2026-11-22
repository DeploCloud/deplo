import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { __resetTestDb, __setTestDb } from "../../db/client";
import { domains as domainsTable } from "../../db/schema/control-plane/domains";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { nowIso } from "../../ids";
import { seedApp } from "../app-graph-test-helpers";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import {
  __forgetMoves,
  __setMoveProbeForTest,
  appMoveState,
  moveLanded,
  moveStarted,
} from "./moves";

let db: TestDb;
let pg: PGlite;
before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServerRow(db, {
    id: "srv_2",
    name: "eu-2",
    ip: "203.0.113.2",
    host: "203.0.113.2",
  });
  await seedApp(db, { id: "prj_web", slug: "web", serverId: "srv_2" });
  await db.insert(domainsTable).values({
    id: "d1",
    appId: "prj_web",
    name: "web.example.com",
    status: "valid",
    isPrimary: true,
    ssl: true,
    source: "custom",
    createdAt: nowIso(),
  });
});
after(async () => {
  __resetTestDb();
  await pg.close();
});
afterEach(() => {
  __forgetMoves();
  __setMoveProbeForTest(null);
});

const app = {
  id: "prj_web",
  serverId: "srv_1",
  clusterId: null,
  volumes: [],
  mounts: [],
  compose: null,
};

test("an App reads Moving to its new server from the leader's decision until it answers there with a valid certificate", async () => {
  moveStarted("prj_web", "srv_2");
  const state = await appMoveState(app, true);
  assert.equal(state.move?.to, "eu-2");
  let asked = 0;
  __setMoveProbeForTest(async (address, name) => {
    assert.equal(address, "203.0.113.2");
    assert.equal(name, "web.example.com");
    return ++asked >= 3;
  });
  assert.equal(await moveLanded("prj_web", "srv_2", { every: 1 }), true);
  assert.equal(asked, 3);
  assert.equal((await appMoveState(app, false)).move, null);
});

test("a move whose new server never answers with a valid certificate stops reading Moving after the wait", async () => {
  moveStarted("prj_web", "srv_2");
  __setMoveProbeForTest(async () => false);
  assert.equal(
    await moveLanded("prj_web", "srv_2", { every: 1, within: 20 }),
    false,
  );
  assert.equal((await appMoveState(app, true)).move, null);
});
