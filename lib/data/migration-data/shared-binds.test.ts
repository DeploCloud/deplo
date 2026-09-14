import {
  asOwner,
  CONNECT,
  closeHarness,
  openHarness,
  openRun,
  resetHarness,
  seedMigrationHostServer,
  seedRunItems,
  state,
  UPLOADS,
} from "./migration-data-test-helpers";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { TestDb } from "../../db/test-harness";
import { appVolumes as appVolumesTable } from "../../db/schema/control-plane/apps";
import { seedApp, SERVER_1 } from "../app-graph-test-helpers";
import { TEAM_A, TEAM_B } from "../identity-test-helpers";
import { moveMigrationServiceData } from "./move";
import { planMigrationDataMove } from "./plan";

let db: TestDb;

before(async () => {
  db = await openHarness();
});

after(closeHarness);

beforeEach(resetHarness);

test("a host directory already on this machine is not copied over itself", async () => {
  await db.execute(
    `update servers set host = 'dokploy.acme.test', ip = 'dokploy.acme.test' where id = '${SERVER_1}'`,
  );
  const runId = await openRun();
  state.volumes[SERVER_1]["blink-web-abc_uploads"] = UPLOADS;
  state.agentCalls = [];

  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(
    state.agentCalls.some((c) => c.includes("wipe-path")),
    false,
    "a directory must never be emptied to restore itself",
  );
  const items = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' and message like '%already on this machine%'`,
  );
  assert.equal(items.rows.length, 1);
});

test("the plan does not call a bind already in place a clash", async () => {
  await db.execute(
    `update servers set host = 'dokploy.acme.test', ip = 'dokploy.acme.test' where id = '${SERVER_1}'`,
  );
  await seedApp(db, { id: "prj_neighbour", teamId: TEAM_A, slug: "neighbour" });
  await db.execute(
    "update apps set name = 'neighbour' where id = 'prj_neighbour'",
  );
  await db.insert(appVolumesTable).values({
    appId: "prj_neighbour",
    position: 0,
    volumeId: "vol_neighbour",
    type: "host",
    name: "shared",
    service: null,
    projectPath: null,
    hostPath: "/etc/dokploy/x",
    mountPath: "/app/config.json",
    readOnly: true,
    propagation: null,
  });
  const runId = await openRun();
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  const web = plan.find((s) => s.sourceName === "blink-web")!;
  assert.match(web.volumes[1].note!, /Already on this machine/);
  assert.equal(
    web.notes.some((n) => /also mounted/.test(n)),
    false,
    web.notes.join(" | "),
  );
});

test("two services of one run that bind one directory share it, copied once", async () => {
  await seedMigrationHostServer();
  await seedApp(db, { id: "prj_neighbour", teamId: TEAM_A, slug: "neighbour" });
  await db.execute(
    "update apps set name = 'neighbour' where id = 'prj_neighbour'",
  );
  await db.insert(appVolumesTable).values({
    appId: "prj_neighbour",
    position: 0,
    volumeId: "vol_neighbour",
    type: "host",
    name: "shared",
    service: null,
    projectPath: null,
    hostPath: "/etc/dokploy/x",
    mountPath: "/app/config.json",
    readOnly: true,
    propagation: null,
  });
  const runId = await openRun();
  await seedRunItems(runId, [
    {
      sourceKind: "application",
      sourceId: "dok-app-ghost",
      sourceName: "neighbour",
      targetKind: "app",
      targetId: "prj_neighbour",
    },
  ]);

  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  const web = plan.find((s) => s.sourceName === "blink-web")!;
  assert.match(web.notes.join(" "), /shared with neighbour/);
  assert.doesNotMatch(web.notes.join(" "), /erase/);

  const first = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(first.failed, 0, JSON.stringify(first));
  let items = await db.execute(
    `select outcome, message from migration_run_items where run_id = '${runId}' and source_name = '/etc/dokploy/x'`,
  );
  assert.deepEqual(
    items.rows.map((r) => r.outcome),
    ["created"],
    JSON.stringify(items.rows),
  );

  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  items = await db.execute(
    `select outcome, message from migration_run_items where run_id = '${runId}' and source_name = '/etc/dokploy/x' order by seq`,
  );
  assert.deepEqual(
    items.rows.map((r) => r.outcome),
    ["created", "skipped"],
    JSON.stringify(items.rows),
  );
  assert.match(
    String(items.rows[1].message),
    /already copied for it in this run/,
  );
});

test("a bind another team's app also mounts is not wiped", async () => {
  await seedMigrationHostServer();
  await seedApp(db, {
    id: "prj_squatter",
    teamId: TEAM_B,
    slug: "squatter",
  });
  await db.execute(
    "update apps set name = 'squatter' where id = 'prj_squatter'",
  );
  await db.insert(appVolumesTable).values({
    appId: "prj_squatter",
    position: 0,
    volumeId: "vol_squat",
    type: "host",
    name: "config",
    service: null,
    projectPath: null,
    hostPath: "/etc/dokploy/x",
    mountPath: "/app/config.json",
    readOnly: false,
    propagation: null,
  });
  const runId = await openRun();

  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  const web = plan.find((s) => s.sourceName === "blink-web");
  assert.ok(
    web!.notes.some((n) => n.includes("another team's app")),
    `the review screen has to say it first: ${web!.notes.join(" | ")}`,
  );

  state.agentCalls = [];
  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(
    res.moved,
    1,
    "the named volume travels, the shared bind does not",
  );
  assert.equal(res.failed, 1, "and it counts as data that did not arrive");
  assert.equal(
    state.hostPaths[SERVER_1],
    undefined,
    "nothing on the host was written",
  );
  assert.ok(
    !state.agentCalls.some((c) => c.startsWith(`${SERVER_1}:wipe-path`)),
    state.agentCalls.join(" | "),
  );
  const items = await db.execute(
    "select outcome, message from migration_run_items where message like '%another team''s app%'",
  );
  assert.ok(items.rows.length >= 1, "the report has to name the other app");
  assert.ok(items.rows.every((r) => r.outcome === "manual"));
});
