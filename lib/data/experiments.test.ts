import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
} from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import { activities } from "../db/schema/control-plane/activity";
import { apps } from "../db/schema/control-plane/apps";
import { clusters } from "../db/schema/control-plane/clusters";
import { instanceSettings } from "../db/schema/control-plane/instance";
import {
  experimentOn,
  listExperimentStates,
  requireExperiment,
  setExperiment,
} from "./experiments";

let db: TestDb;
let pg: PGlite;

const ADMIN = "admin1";
const MEMBER = "member2";
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
    truncate table clusters, activities restart identity cascade;
    ${TRUNCATE_IDENTITY}`);
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await seedServer(db);
  await seedApp(db, { id: "app_web", slug: "web", teamId: TEAM_A });
});

const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId, teamId: TEAM_A }, fn);

test("a fresh install has every experiment off, and a gate says how to turn it on", async () => {
  assert.equal(await as(MEMBER, () => experimentOn("crons")), false);
  await assert.rejects(
    () => as(MEMBER, () => requireExperiment("crons")),
    /Cron jobs are not turned on for this Deplo\. An instance admin/,
  );
});

test("an admin turns one on for everyone, and Activity says who", async () => {
  const state = await as(ADMIN, () => setExperiment("crons", true));
  assert.deepEqual(state, {
    key: "crons",
    enabled: true,
    usage: null,
    lockedOn: null,
  });
  assert.equal(await as(MEMBER, () => experimentOn("crons")), true);
  const trail = await db.select({ m: activities.message }).from(activities);
  assert.deepEqual(
    trail.map((r) => r.m),
    ["Turned on the Cron jobs experiment"],
  );
  await as(ADMIN, () => setExperiment("crons", true));
  assert.equal(
    (await db.select().from(activities)).length,
    1,
    "the same state twice is not a second entry",
  );
});

test("a member cannot flip an experiment or read their usage", async () => {
  await assert.rejects(() => as(MEMBER, () => setExperiment("crons", true)));
  await assert.rejects(() => as(MEMBER, () => listExperimentStates()));
});

test("a cluster keeps Server clusters on, while an app setting only pauses", async () => {
  await db.insert(clusters).values({ id: "clu_1", name: "eu", createdAt: T0 });
  await db.update(apps).set({ cronEnabled: true });
  await as(ADMIN, () => setExperiment("clusters", true));
  await as(ADMIN, () => setExperiment("crons", true));
  await assert.rejects(
    () => as(ADMIN, () => setExperiment("clusters", false)),
    /Cluster eu is still there/,
  );
  const crons = await as(ADMIN, () => setExperiment("crons", false));
  assert.equal(crons.enabled, false);
  assert.equal(crons.usage, "1 app, 0 jobs");
  const [row] = await db
    .select({ cron: apps.cronEnabled })
    .from(apps)
    .where(eq(apps.id, "app_web"));
  assert.equal(row.cron, true, "the app keeps its own setting");
});

const upgradeDefaults = readFileSync(
  new URL("../db/migrations/0262_experiments.sql", import.meta.url),
  "utf8",
)
  .split("--> statement-breakpoint")
  .find((s) => s.includes('INSERT INTO "instance_settings"'))!;

test("an upgrade turns on exactly the experiments already in use", async () => {
  await db.update(apps).set({ cronEnabled: true });
  await db.insert(clusters).values({ id: "clu_1", name: "eu", createdAt: T0 });
  await pg.exec(upgradeDefaults);
  const [row] = await db
    .select({
      crons: instanceSettings.experimentCrons,
      zeroDowntime: instanceSettings.experimentZeroDowntime,
      pullRequests: instanceSettings.experimentPullRequests,
      clusters: instanceSettings.experimentClusters,
      tunnels: instanceSettings.experimentTunnels,
    })
    .from(instanceSettings);
  assert.deepEqual(row, {
    crons: true,
    zeroDowntime: false,
    pullRequests: false,
    clusters: true,
    tunnels: false,
  });
});

test("an install that uses none of them gets no settings row from the upgrade", async () => {
  await pg.exec(upgradeDefaults);
  assert.equal((await db.select().from(instanceSettings)).length, 0);
});

test("a panel tunnel keeps Tunnels on", async () => {
  await as(ADMIN, () => setExperiment("tunnels", true));
  await db
    .update(instanceSettings)
    .set({ panelTunnelHostname: "panel.example.com" });
  await assert.rejects(
    () => as(ADMIN, () => setExperiment("tunnels", false)),
    /The panel is still reached through a tunnel/,
  );
});

const tunnelsInUse = readFileSync(
  new URL(
    "../db/migrations/0280_tunnels_experiment_in_use.sql",
    import.meta.url,
  ),
  "utf8",
);

test("an upgrade turns Tunnels back on only where a tunnel is in use", async () => {
  await db
    .insert(instanceSettings)
    .values({ id: "default", updatedAt: T0, panelTunnelHostname: null });
  await pg.exec(tunnelsInUse);
  assert.equal(await as(MEMBER, () => experimentOn("tunnels")), false);
  await db
    .update(instanceSettings)
    .set({ panelTunnelHostname: "panel.example.com" });
  await pg.exec(tunnelsInUse);
  assert.equal(await as(MEMBER, () => experimentOn("tunnels")), true);
});
