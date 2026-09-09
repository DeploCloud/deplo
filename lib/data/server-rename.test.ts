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
import { renameServer, getServerById, addServer } from "./servers";
import { activities } from "../db/schema/control-plane";

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
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "user_member", teamId: TEAM_A, role: "member" },
    ],
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

test("adding a server truncates an over-long name instead of refusing", async () => {
  await asOwner(async () => {
    const { server } = await addServer({
      name: "n".repeat(80),
      host: "10.9.9.9",
      importOnly: true,
    });
    assert.equal(server.name.length, 60);
  });
});

test("adding a server with no name still falls back to the host", async () => {
  await asOwner(async () => {
    const { server } = await addServer({
      name: "   ",
      host: "10.9.9.8",
      importOnly: true,
    });
    assert.equal(server.name, "10.9.9.8");
  });
});

test("a plain member cannot rename a server", async () => {
  await runWithIdentity({ userId: "user_member", teamId: TEAM_A }, async () => {
    await assert.rejects(
      () => renameServer(SERVER_1, "not-mine"),
      /admin|not authorized|permission/i,
    );
  });
  await asOwner(async () => {
    assert.notEqual((await getServerById(SERVER_1))!.name, "not-mine");
  });
});

test("the activity trail names both the old and the new name", async () => {
  await asOwner(async () => {
    const before = (await getServerById(SERVER_1))!.name;
    await renameServer(SERVER_1, "eu-main-9");
    const rows = await db
      .select({ message: activities.message })
      .from(activities);
    assert.ok(
      rows.some((r) => r.message === `Renamed server ${before} to eu-main-9`),
      JSON.stringify(rows.map((r) => r.message)),
    );
  });
});
