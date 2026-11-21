import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import {
  clusterMembers,
  clusters,
} from "../../db/schema/control-plane/clusters";
import { domains } from "../../db/schema/control-plane/domains";
import { servers } from "../../db/schema/control-plane/servers";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { seedApp, TRUNCATE_PROJECT_GRAPH } from "../app-graph-test-helpers";
import { loadAppGraph } from "../app-graph-load";
import { generatedAddressesAway } from "./failover-address";

let db: TestDb;
let pg: PGlite;
const CLUSTER = "clu_lb";
const APP = "prj_web";
const T0 = "2026-11-21T00:00:00.000Z";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});
after(async () => {
  __resetTestDb();
  await pg.close();
});

const domain = (id: string, name: string, extra = {}) => ({
  id,
  appId: APP,
  name,
  status: "valid",
  isPrimary: false,
  ssl: false,
  certProvider: "none",
  createdAt: T0,
  ...extra,
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table cluster_members, clusters,
    membership_capabilities, memberships, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await db.insert(clusters).values({
    id: CLUSTER,
    name: "eu",
    replicationEnabled: true,
    loadBalancingEnabled: true,
    createdAt: T0,
  });
  for (const [id, ip] of [
    ["srv_2", "10.0.0.2"],
    ["srv_3", "10.0.0.3"],
  ]) {
    await seedServerRow(db, { id, name: `lab-${id.slice(-1)}`, ip, host: ip });
    await db
      .insert(clusterMembers)
      .values({ serverId: id, clusterId: CLUSTER, joinedAt: T0 });
  }
  await seedApp(db, { id: APP, slug: "web", repo: null, serverId: "srv_3" });
  await db
    .update(appsTable)
    .set({ clusterId: CLUSTER })
    .where(eq(appsTable.id, APP));
  await db
    .insert(domains)
    .values([
      domain("dom_own", "shop.acme.com", { answersEverywhere: true }),
      domain("dom_2", "web-word-0a000002.deplo.site", { source: "auto" }),
      domain("dom_3", "web-word-0a000003.deplo.site", { source: "auto" }),
    ]);
});

const away = async () => generatedAddressesAway((await loadAppGraph(APP))!);
const lease = (id: string, leaseState: "ok" | "fenced") =>
  db
    .update(clusterMembers)
    .set({ leaseState })
    .where(
      and(
        eq(clusterMembers.serverId, id),
        eq(clusterMembers.clusterId, CLUSTER),
      ),
    );

test("a load-balanced App's generated address says its server is away, and names the domain to use", async () => {
  assert.deepEqual(await away(), {});
  await lease("srv_2", "fenced");
  assert.deepEqual(await away(), {
    dom_2: { server: "lab-2", use: "shop.acme.com" },
  });
  await lease("srv_2", "ok");
  await db
    .update(servers)
    .set({ status: "offline" })
    .where(eq(servers.id, "srv_3"));
  assert.deepEqual(await away(), {
    dom_3: { server: "lab-3", use: "shop.acme.com" },
  });
});

test("an App the cluster does not balance says nothing: its generated address follows it", async () => {
  await lease("srv_2", "fenced");
  await db
    .update(clusters)
    .set({ loadBalancingEnabled: false })
    .where(eq(clusters.id, CLUSTER));
  assert.deepEqual(await away(), {});
});
