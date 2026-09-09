import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import {
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { renameServer, getServerById } from "./servers";

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
    truncate table registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db);
});

const asOwner = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("a server is renamed, trimmed", async () => {
  await asOwner(async () => {
    const s = await renameServer(SERVER_1, "  eu-west-2  ");
    assert.equal(s.name, "eu-west-2");
    assert.equal((await getServerById(SERVER_1))!.name, "eu-west-2");
  });
});

test("an empty or overlong name is refused, and so is an unknown server", async () => {
  await asOwner(async () => {
    await assert.rejects(() => renameServer(SERVER_1, "   "), /required/);
    await assert.rejects(
      () => renameServer(SERVER_1, "a".repeat(61)),
      /60 characters/,
    );
    await assert.rejects(
      () => renameServer("srv_nope", "whatever"),
      /not found/,
    );
  });
});
