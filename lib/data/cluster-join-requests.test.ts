import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import {
  clusterJoinRequests,
  clusters,
} from "../db/schema/control-plane/clusters";
import { servers } from "../db/schema/control-plane/servers";
import { addServer } from "./servers/enrollment";
import { recordFirstLink } from "./servers/agent-handshake";
import { activities } from "../db/schema/control-plane/activity";
import {
  cancelClusterJoin,
  joinWaitingServers,
  listClusterJoinRequests,
} from "./clusters/join-requests";
import {
  turnOffExperiments,
  turnOnExperiments,
} from "./experiments-test-helpers";

let db: TestDb;
let pg: PGlite;
const T0 = "2026-01-01T00:00:00.000Z";

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
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await db.insert(clusters).values({ id: "clu_eu", name: "eu", createdAt: T0 });
  await turnOnExperiments(db, "clusters");
});

const asOwner = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

const addFor = (clusterId: string) =>
  asOwner(() => addServer({ name: "new-one", clusterId }));

test("a server added from inside a cluster waits to join it", async () => {
  const { server } = await addFor("clu_eu");
  const waiting = await asOwner(() => listClusterJoinRequests());
  assert.deepEqual(waiting.get(server.id), {
    clusterId: "clu_eu",
    clusterName: "eu",
    error: "",
  });
});

test("with the experiment off, nothing is added, not even half a server", async () => {
  await turnOffExperiments(db, "clusters");
  await assert.rejects(
    () => addFor("clu_eu"),
    /Server clusters are not turned on/,
  );
  assert.equal(
    (await db.select().from(servers).where(eq(servers.name, "new-one"))).length,
    0,
  );
});

test("a server that is not installed yet is not tried", async () => {
  await addFor("clu_eu");
  assert.equal(await joinWaitingServers(), 0);
  const [row] = await db.select().from(clusterJoinRequests);
  assert.equal(row.triedAt, null);
});

test("a refused join keeps waiting, says why, and is tried again only after a minute", async () => {
  const { server } = await addFor("clu_eu");
  await db
    .update(servers)
    .set({ status: "online", agentCertFingerprint: "a".repeat(64) })
    .where(eq(servers.id, server.id));
  const now = Date.now();
  assert.equal(await joinWaitingServers(now), 0);
  const [row] = await db.select().from(clusterJoinRequests);
  assert.match(row.error, /.+/, "the refusal is kept for the card");
  assert.ok(row.triedAt);
  const tried = row.triedAt;
  await joinWaitingServers(now + 10_000);
  const [again] = await db.select().from(clusterJoinRequests);
  assert.equal(again.triedAt, tried, "not asked again within a minute");
});

// c49: "Connected server eu-5" was written at addServer, for a server that never ran an agent.
test("a server is connected on Activity at its agent's first link, not when it is added", async () => {
  const { server } = await addFor("clu_eu");
  const said = async () =>
    (await db.select({ m: activities.message }).from(activities)).map(
      (r) => r.m,
    );
  assert.ok((await said()).includes("Added server new-one"));
  assert.ok(!(await said()).includes("Connected server new-one"));
  await recordFirstLink(server.id);
  await recordFirstLink(server.id);
  assert.equal(
    (await said()).filter((m) => m === "Connected server new-one").length,
    1,
  );
});

test("cancelling leaves the server as one of yours, and says so in Activity", async () => {
  const { server } = await addFor("clu_eu");
  await asOwner(() => cancelClusterJoin(server.id));
  assert.equal((await db.select().from(clusterJoinRequests)).length, 0);
  assert.equal(
    (await db.select().from(servers).where(eq(servers.id, server.id))).length,
    1,
  );
});
