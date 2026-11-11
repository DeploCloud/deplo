import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-move-after-"));

import { __resetReleaseCacheForTests } from "../../agent/release";
import { runWithIdentity } from "../../auth/request-context";
import { __resetTestDb, __setTestDb } from "../../db/client";
import { clusters as clustersTable } from "../../db/schema/control-plane/clusters";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import {
  __resetQueueForTest,
  __setRunnerForTest,
} from "../../deploy/deploy-queue";
import { __setClusterPinForTest } from "../../infra/agent-client/cluster-host";
import { fakeClusterHosts } from "../../infra/agent-client/cluster-test-helpers";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../../migration/transport";
import { newTestLeader } from "../cluster-leader-test-helpers";
import { forgetLeaderRoster } from "../clusters/leader-sync";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { invalidateFrozen } from "./freeze";
import {
  __setAfterMoveForTest,
  __setRestorerForTest,
  __waitForMoveForTest,
} from "./runner";
import { invalidateSchedulesPaused } from "./schedules";
import { connectMove, moveStatus, startMove } from "./target";
import {
  MOVE_CODE,
  NEW,
  OLD,
  SELF_IP,
  dumpOf,
  fakeOldDeplo,
  helloOf,
  summary,
} from "./target-test-helpers";

// The jobs a move runs once its copy has landed, through the runner itself: nothing here stands in for them.

let db: TestDb;
let pg: PGlite;
const origFetch = globalThis.fetch;
const SUMS =
  `${"a".repeat(64)}  deplo-cluster-linux-amd64\n` +
  `${"b".repeat(64)}  deplo-cluster-linux-arm64\n`;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  __setRunnerForTest(async () => {});
  process.env.DEPLO_PUBLIC_URL = NEW;
  process.env.DEPLO_SERVER_IP = SELF_IP;
});

after(async () => {
  __resetMigrationFetchForTest();
  __setRestorerForTest();
  __setAfterMoveForTest();
  __setClusterPinForTest(null);
  __resetReleaseCacheForTests();
  __resetQueueForTest();
  globalThis.fetch = origFetch;
  invalidateFrozen();
  invalidateSchedulesPaused();
  __resetTestDb();
  await pg.close();
  rmSync(process.env.DEPLO_DATA_DIR!, { recursive: true, force: true });
});

beforeEach(async () => {
  await pg.exec(`truncate table deplo_moves, deplo_move_servers,
    deplo_move_workloads, clusters, servers, apps, databases, deployments,
    activities, registration_links, membership_capabilities, memberships,
    users, teams, instance_settings restart identity cascade;`);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }],
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServerRow(db, {
    id: "srv_self",
    name: "this-machine",
    ip: SELF_IP,
    host: SELF_IP,
  });
  __setClusterPinForTest({ version: "0.2.0", min: "0.2.0" });
  __resetReleaseCacheForTests();
  forgetLeaderRoster();
  globalThis.fetch = (async () => new Response(SUMS)) as typeof fetch;
  invalidateFrozen();
  invalidateSchedulesPaused();
});

test("once the copy lands, the move starts this machine's leader and has it lead the copied clusters", async () => {
  const fleet = fakeClusterHosts();
  const leader = await newTestLeader();
  // The agent of the new machine has never run a leader.
  const self = fleet.host("srv_self", { leader: leader.calls });
  __setMigrationFetchForTest(
    fakeOldDeplo({
      hello: helloOf({
        counts: { teams: 1, users: 1, apps: 0, databases: 0, servers: 1 },
        servers: [summary({ id: "srv_web", name: "web" })],
      }),
      dump: dumpOf({}),
      workloads: [],
      data: {},
    }).fetch,
  );
  // Stands in for the copy engine only: the old Deplo's rows, a cluster its own machine led at epoch 4.
  __setRestorerForTest(async (lines) => {
    for await (const line of lines) void line;
    await pg.exec(
      "truncate table memberships, membership_capabilities, users, teams cascade",
    );
    await seedIdentity(db, {
      teams: [{ id: "team_src1", slug: "src1" }],
      users: [{ id: "user_src", teamId: "team_src1", role: "owner" }],
    });
    await db.insert(clustersTable).values({
      id: "clu_copied",
      name: "eu",
      leaderEpoch: 4,
      createdAt: new Date().toISOString(),
    });
    return { rows: 3, unreadable: 0 };
  });
  __setAfterMoveForTest();

  try {
    const asAdmin = <T>(fn: () => Promise<T>) =>
      runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
    const preview = await asAdmin(() =>
      connectMove({ url: OLD, code: MOVE_CODE }),
    );
    assert.equal(preview.canStart, true, preview.problems.join(" "));
    await asAdmin(() =>
      startMove(preview.id, [{ from: "srv_web", to: "srv_self" }]),
    );
    await __waitForMoveForTest();

    const status = await moveStatus(preview.id);
    assert.equal(status?.state, "done", status?.error ?? "");
    assert.deepEqual(
      self.installs.map((i) => [i.version, i.relay]),
      [["0.2.0", true]],
    );
    // The old machine's leader may still run at epoch 4: this one is never handed it.
    assert.deepEqual(leader.rosters.map((r) => [r.cluster, r.epoch]).at(-1), [
      "clu_copied",
      5,
    ]);
    const [cluster] = await db.select().from(clustersTable);
    assert.equal(cluster.leaderEpoch, 5);
  } finally {
    fleet.restore();
  }
});
