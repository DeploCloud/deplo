import {
  asOwner,
  CONNECT,
  CONTAINERS,
  closeHarness,
  openHarness,
  openRun,
  resetHarness,
  seedMigrationHostServer,
  seedRunItems,
  state,
} from "./migration-data-test-helpers";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { TestDb } from "../../db/test-harness";
import { appVolumes as appVolumesTable } from "../../db/schema/control-plane/apps";
import {
  beginMigration,
  finishMigration,
} from "../migration-import/run-lifecycle";
import { planMigrationDataMove } from "./plan";

let db: TestDb;

before(async () => {
  db = await openHarness();
});

after(closeHarness);

beforeEach(resetHarness);

test("the plan pairs an imported app's volume with the one Deplo will mount", async () => {
  const runId = await openRun();
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  const web = plan.find((s) => s.sourceName === "blink-web");
  assert.ok(web, JSON.stringify(plan.map((s) => s.sourceName)));
  assert.equal(web.path, "Blink / production / blink-web");
  assert.equal(web.targetKind, "app");
  assert.equal(web.targetId, "prj_web");
  assert.equal(web.running, true);
  assert.deepEqual(
    web.volumes.map(
      (v) => `${v.sourceVolume}->${v.targetVolume}@${v.mountPath}`,
    ),
    [
      "blink-web-abc_uploads->deplo-blink-web-uploads@/app/uploads",
      "/etc/dokploy/x->/etc/dokploy/x@/app/config.json",
    ],
  );
  assert.match(web.volumes[1].note!, /path on the host, not a volume/);
});

test("a second run still moves the data of what the first one created", async () => {
  const first = await openRun();
  await asOwner(() => finishMigration(first));
  const second = await asOwner(() => beginMigration({ url: CONNECT.url }));
  await seedRunItems(second, [
    {
      sourceKind: "application",
      sourceId: "dok-app-web",
      sourceName: "blink-web",
      targetKind: "app",
      targetId: "prj_web",
      outcome: "skipped",
    },
    {
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
      sourceName: "blink-db",
      targetKind: "database",
      targetId: "db_blink",
      outcome: "skipped",
    },
  ]);
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId: second }),
  );
  assert.deepEqual(
    plan.map((s) => s.sourceName).sort(),
    ["blink-db", "blink-web"],
    "a second run has to find what the first created, marker or no marker",
  );
});

test("a service that was never imported is not listed at all", async () => {
  const runId = await openRun();
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  assert.equal(
    plan.some((s) => s.sourceName === "never-imported"),
    false,
  );
});

test("a database pairs 1:1 and says the data directory moved", async () => {
  const runId = await openRun();
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  const database = plan.find((s) => s.targetKind === "database");
  assert.ok(database);
  assert.equal(database.targetId, "db_blink");
  assert.equal(database.volumes.length, 1);
  assert.equal(
    database.volumes[0].targetVolume,
    "deplo-db-blink-db_db-blink-db-data",
  );
  assert.match(database.volumes[0].note!, /data directory moved/);
});

test("the plan reads both sides and writes to neither", async () => {
  const runId = await openRun();
  await asOwner(() => planMigrationDataMove({ ...CONNECT, runId }));
  assert.equal(
    state.calls.some((p) => p.endsWith(".stop")),
    false,
    "planning must never stop anything",
  );
  assert.ok(state.calls.includes("docker.getConfig"));
});

test("the plan says so when Deplo has no agent on the machine holding the data", async () => {
  const runId = await openRun();
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  assert.ok(
    plan.every((svc) =>
      svc.notes.some((n) => /no agent on the machine/.test(n)),
    ),
    JSON.stringify(plan.map((s) => s.notes)),
  );
});

test("the plan tells an enrolled-but-unreachable machine apart from a missing one", async () => {
  await seedMigrationHostServer();
  state.unreachableAgents.add("srv_migration_host");
  const runId = await openRun();

  const bad = await asOwner(() => planMigrationDataMove({ ...CONNECT, runId }));
  assert.ok(bad.length > 0);
  assert.ok(
    bad.every((svc) => svc.sourceReachable === false),
    "a machine that will not answer is not a machine we can read",
  );
  assert.ok(
    bad.every((svc) => svc.notes.some((n) => /cannot reach the agent/.test(n))),
    JSON.stringify(bad.map((s) => s.notes)),
  );

  state.unreachableAgents.delete("srv_migration_host");
  const good = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  assert.ok(good.every((svc) => svc.sourceReachable === true));
});

test("a resource this run did not create is not reachable at all", async () => {
  const runId = await asOwner(() => beginMigration({ url: CONNECT.url }));
  await seedRunItems(runId, [
    {
      sourceKind: "application",
      sourceId: "dok-app-web",
      sourceName: "blink-web",
      targetKind: "app",
      targetId: "prj_web",
    },
  ]);
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  assert.equal(
    plan.some((s) => s.targetKind === "database"),
    false,
    "a database this run did not import must never be a copy target",
  );
});

test("a resource the run only SKIPPED is left alone, data included", async () => {
  const runId = await asOwner(() => beginMigration({ url: CONNECT.url }));
  await seedRunItems(runId, [
    {
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
      sourceName: "blink-db",
      targetKind: "database",
      targetId: "db_blink",
      outcome: "skipped",
    },
  ]);
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  assert.deepEqual(plan, []);
});

test("a stopped app's config file is not an unfilled bind", async () => {
  await db.insert(appVolumesTable).values({
    appId: "prj_web",
    position: 2,
    volumeId: "vol_hello",
    type: "app",
    name: "hello.txt",
    service: null,
    projectPath: "hello.txt",
    hostPath: null,
    mountPath: "/etc/mx/hello.txt",
    readOnly: false,
    propagation: null,
  });
  const live = CONTAINERS["blink-web-abc"];
  CONTAINERS["blink-web-abc"] = [];
  try {
    const runId = await openRun();
    const plan = await asOwner(() =>
      planMigrationDataMove({ ...CONNECT, runId }),
    );
    const web = plan.find((s) => s.sourceName === "blink-web")!;
    assert.equal(web.running, false);
    assert.ok(
      !web.notes.some((n) => /beside this stack's compose file/.test(n)),
      web.notes.join(" | "),
    );
  } finally {
    CONTAINERS["blink-web-abc"] = live;
  }
});
