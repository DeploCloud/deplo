import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  clusterMembers,
  clusterWarnings,
  clusters,
} from "../db/schema/control-plane/clusters";
import { runWithIdentity } from "../auth/request-context";
import { seedIdentity, TEAM_A, USER_1 } from "./identity-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { TRUNCATE_PROJECT_GRAPH } from "./app-graph-test-helpers";
import { getClusterById } from "./clusters/roster";
import { leaderWarnings } from "../clusters/warnings";
import type { ClusterLeader } from "../types/cluster";
import {
  loadClusterWarnings,
  refreshClusterWarnings,
  storedClusterWarnings,
} from "./clusters/warnings";

let db: TestDb;
let pg: PGlite;
const CLUSTER = "clu_warn";
const T0 = "2026-11-14T00:00:00.000Z";

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
    truncate table cluster_warnings, cluster_members, clusters,
    membership_capabilities, memberships, users, teams
    restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: "u_member", teamId: TEAM_A, role: "member" },
    ],
  });
  await db.insert(clusters).values({ id: CLUSTER, name: "eu", createdAt: T0 });
  for (const id of ["srv_w1", "srv_w2"]) {
    await seedServerRow(db, { id, name: id });
    await db
      .insert(clusterMembers)
      .values({ serverId: id, clusterId: CLUSTER, joinedAt: T0 });
  }
});

const asAdmin = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("a leader Deplo cannot read is stored as a warning, and read back without asking a server", async () => {
  await refreshClusterWarnings((await getClusterById(CLUSTER))!);
  const stored = await asAdmin(() => storedClusterWarnings([CLUSTER]));
  const list = stored.get(CLUSTER) ?? [];
  assert.equal(list[0]?.key, "leader");
  assert.equal(list[0]?.title, "Failover is not working right now");
});

test("a cluster with failover off stores nothing, and its old warnings go", async () => {
  await refreshClusterWarnings((await getClusterById(CLUSTER))!);
  await db
    .update(clusters)
    .set({ failoverEnabled: false })
    .where(eq(clusters.id, CLUSTER));
  await refreshClusterWarnings((await getClusterById(CLUSTER))!);
  assert.equal((await db.select().from(clusterWarnings)).length, 0);
});

test("the page adds what changed since the last check: failover off hides a stored warning at once", async () => {
  const stored = [
    { key: "leader", title: "Failover is not working right now", body: "x" },
  ];
  const on = (await getClusterById(CLUSTER))!;
  const shown = await asAdmin(() => loadClusterWarnings(on, 2, stored));
  assert.deepEqual(
    shown.map((w) => w.key),
    ["leader"],
  );
  const off = { ...on, failoverEnabled: false };
  assert.deepEqual(
    await asAdmin(() => loadClusterWarnings(off, 2, stored)),
    [],
  );
  // One server left: the stored leader check no longer applies.
  assert.deepEqual(
    (await asAdmin(() => loadClusterWarnings(on, 1, stored))).map((w) => w.key),
    ["one-server"],
  );
});

test("reading the stored warnings is for an instance admin", async () => {
  await assert.rejects(
    runWithIdentity({ userId: "u_member", teamId: TEAM_A }, () =>
      storedClusterWarnings([CLUSTER]),
    ),
  );
});

test("a relay warning Cloudflare's token causes carries the fix, and keeps it once stored", async () => {
  const leader = {
    state: "running",
    failoverReady: true,
    takenOverAt: null,
    updateMessage: "",
    relayMessage: "Cloudflare refused Deplo's change.",
    relayNeedsToken: true,
    ownServerWarning: "",
  } as unknown as ClusterLeader;
  const [relay] = leaderWarnings(leader);
  assert.equal(relay?.key, "relay");
  assert.equal(relay?.fixCloudflareToken, true);
  assert.equal(
    leaderWarnings({ ...leader, relayNeedsToken: false })[0]
      ?.fixCloudflareToken,
    undefined,
    "another relay problem has no token to fix",
  );

  await db.insert(clusterWarnings).values({
    clusterId: CLUSTER,
    key: "relay",
    position: 0,
    title: relay!.title,
    body: relay!.body,
    fixCloudflareToken: true,
    checkedAt: T0,
  });
  const stored = await asAdmin(() => storedClusterWarnings([CLUSTER]));
  assert.equal(stored.get(CLUSTER)?.[0]?.fixCloudflareToken, true);
});
