import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { clusters } from "../db/schema/control-plane/clusters";
import { addServer } from "./servers/enrollment";
import {
  displayPositions,
  reorderClusters,
  reorderServers,
} from "./servers/display-order";
import {
  turnOffExperiments,
  turnOnExperiments,
} from "./experiments-test-helpers";

let db: TestDb;
let pg: PGlite;
const T0 = "2026-01-01T00:00:00.000Z";
const MEMBER = "user_member";

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
    truncate table clusters, activities, registration_links, membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await turnOnExperiments(db, "clusters");
});

const asOwner = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: MEMBER, teamId: TEAM_A }, fn);

async function threeServers() {
  const ids: string[] = [];
  for (const [i, name] of ["a", "b", "c"].entries())
    ids.push((await asOwner(() => addServer({ name }))).server.id);
  return ids;
}

const serverOrder = async () =>
  [...(await asOwner(() => displayPositions())).servers.entries()]
    .sort((x, y) => x[1] - y[1])
    .map(([id]) => id);

test("the order an admin sets is saved for everyone, and the servers left out follow it", async () => {
  const [a, b, c] = await threeServers();
  assert.equal((await serverOrder()).length, 0);
  await asOwner(() => reorderServers([c, a]));
  assert.deepEqual(await serverOrder(), [c, a, b]);
  await asOwner(() => reorderServers([b]));
  assert.deepEqual(await serverOrder(), [b, c, a]);
});

test("an id that is not a server, or one given twice, changes nothing else", async () => {
  const [a, b, c] = await threeServers();
  await asOwner(() => reorderServers([b, "srv_gone", b, a]));
  assert.deepEqual(await serverOrder(), [b, a, c]);
});

test("only an instance admin reorders servers and clusters", async () => {
  const [a] = await threeServers();
  await assert.rejects(() => asMember(() => reorderServers([a])));
  await assert.rejects(() => asMember(() => reorderClusters([])));
  assert.equal((await serverOrder()).length, 0);
});

test("clusters keep their own order, and only with clusters turned on", async () => {
  await db.insert(clusters).values([
    { id: "clu_eu", name: "eu", createdAt: T0 },
    { id: "clu_us", name: "us", createdAt: T0 },
  ]);
  await asOwner(() => reorderClusters(["clu_us"]));
  const placed = (await asOwner(() => displayPositions())).clusters;
  assert.deepEqual(
    [...placed.entries()].sort((x, y) => x[1] - y[1]).map(([id]) => id),
    ["clu_us", "clu_eu"],
  );
  await turnOffExperiments(db, "clusters");
  await assert.rejects(
    () => asOwner(() => reorderClusters(["clu_eu"])),
    /Server clusters are not turned on/,
  );
});
