import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  deployments as deploymentsTable,
  serverTeams as serverTeamsTable,
} from "../db/schema/control-plane";
import { seedServerRow } from "../data/infra-test-helpers";
import { seedIdentity, TEAM_A, USER_1 } from "../data/identity-test-helpers";
import {
  seedApp,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "../data/app-graph-test-helpers";
import { resolveBuildPlan } from "./build-server";
import type { Server } from "../types";

/**
 * The build plan against a real fleet (pglite): team access, and how many builds
 * each host is already running.
 */

let db: TestDb;
let pg: PGlite;

const PANEL = "srv_panel";
const BUILDER = "srv_build";
const SPARE = "srv_spare";
const OTHER = "srv_other";
const TARGET = "srv_app";
const APP = "prj_plan";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_SERVER_IP = "10.9.0.1";
});

after(async () => {
  __resetTestDb();
  delete process.env.DEPLO_SERVER_IP;
  await pg.close();
});

let target: Server;

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table server_teams, users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  // The Deplo host answers on DEPLO_SERVER_IP, which is what makes it the default
  // fallback with nothing configured.
  await seedServerRow(db, { id: PANEL, ip: "10.9.0.1", host: "10.9.0.1" });
  target = await seedServerRow(db, {
    id: TARGET,
    ip: "203.0.113.10",
    host: "203.0.113.10",
  });
  await seedServerRow(db, {
    id: BUILDER,
    ip: "203.0.113.11",
    host: "203.0.113.11",
    buildOnly: true,
    status: "offline",
  });
  await seedApp(db, { id: APP, serverId: TARGET, buildServerId: BUILDER });
});

const planFor = () =>
  resolveBuildPlan(
    {
      teamId: TEAM_A,
      serverId: TARGET,
      buildServerId: BUILDER,
      buildFallback: true,
    },
    target,
  );

test("a build server that is down hands the build to the Deplo host", async () => {
  const plan = await planFor();
  assert.deepEqual(plan.chain, [PANEL]);
  assert.equal(plan.local, true);
});

test("a fallback this team cannot reach is never asked to build", async () => {
  // It would be handed the app's source and its DECRYPTED env, so the grant is the
  // whole question - being marked as a fallback is not enough.
  await seedServerRow(db, {
    id: SPARE,
    ip: "203.0.113.12",
    host: "203.0.113.12",
    buildFallback: true,
    allTeams: false,
  });
  assert.deepEqual((await planFor()).chain, [PANEL]);

  await db.insert(serverTeamsTable).values({ serverId: SPARE, teamId: TEAM_A });
  assert.deepEqual((await planFor()).chain, [PANEL, SPARE]);
});

test("a busy fallback goes last, counted from the deployments actually building", async () => {
  await seedServerRow(db, {
    id: SPARE,
    ip: "203.0.113.12",
    host: "203.0.113.12",
    buildFallback: true,
    createdAt: "2025-01-01T00:00:00.000Z",
  });
  await seedServerRow(db, {
    id: OTHER,
    ip: "203.0.113.13",
    host: "203.0.113.13",
    buildFallback: true,
  });
  await seedDeployment(db, {
    id: "dpl_busy",
    appId: APP,
    status: "building",
    serverId: TARGET,
  });
  await db
    .update(deploymentsTable)
    .set({ buildServerId: SPARE })
    .where(eq(deploymentsTable.id, "dpl_busy"));

  const chain = (await planFor()).chain;
  assert.equal(chain[0], PANEL, "the Deplo host still leads the pool");
  assert.deepEqual(
    chain.slice(1),
    [OTHER, SPARE],
    "the host already building goes last, older row or not",
  );
});
