import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import {
  clusterMembers,
  clusters,
} from "../../db/schema/control-plane/clusters";
import {
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "../app-graph-test-helpers";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import type { Report } from "./run-report";
import {
  landingServerId,
  resolvePlacements,
  resolveServers,
} from "./target-servers";

let db: TestDb;
let pg: PGlite;
const AT = "2026-01-01T00:00:00.000Z";

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
    truncate table clusters, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  // The oldest server is in a cluster; srv_free is a server of its own.
  await seedServer(db);
  await seedServerRow(db, { id: "srv_free" });
  await db.insert(clusters).values({ id: "clu_1", name: "eu", createdAt: AT });
  await db
    .insert(clusterMembers)
    .values({ serverId: SERVER_1, clusterId: "clu_1", joinedAt: AT });
});

test("an import never lands on a cluster member picked as a server: it falls back, and the report says so", async () => {
  const lines: { message: string }[] = [];
  const report = {
    add: async (l: { message: string }) => void lines.push(l),
  } as unknown as Report;

  const placed = await resolvePlacements(
    TEAM_A,
    [
      { serviceId: "svc_member", serverId: SERVER_1 },
      { serviceId: "svc_free", serverId: "srv_free" },
    ],
    report,
    "shop",
  );
  assert.deepEqual([...placed.keys()], ["svc_free"]);
  assert.match(lines[0].message, /not one this team can deploy to/);

  const hosts = await resolveServers(
    TEAM_A,
    [{ from: "old-host", to: SERVER_1 }],
    report,
    "shop",
  );
  assert.equal(hosts.size, 0);

  assert.equal(
    await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
      landingServerId(undefined),
    ),
    "srv_free",
  );
});
