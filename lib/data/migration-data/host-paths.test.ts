import {
  asOwner,
  CONFIG_DIR,
  CONNECT,
  closeHarness,
  openHarness,
  openRun,
  resetHarness,
  seedMigrationHostServer,
  state,
} from "./migration-data-test-helpers";

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { TestDb } from "../../db/test-harness";
import { appVolumes as appVolumesTable } from "../../db/schema/control-plane/apps";
import { SERVER_1 } from "../app-graph-test-helpers";
import { moveMigrationServiceData } from "./move";

let db: TestDb;

before(async () => {
  db = await openHarness();
});

after(closeHarness);

beforeEach(resetHarness);

test("a bind mount's host directory is copied too, and says it is a directory", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  state.agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(res.moved, 2, JSON.stringify(res));
  assert.ok(
    state.agentCalls.includes("srv_migration_host:export-path:/etc/dokploy/x"),
    state.agentCalls.join(" | "),
  );
  assert.deepEqual(state.hostPaths[SERVER_1]["/etc/dokploy/x"], CONFIG_DIR);
  const items = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' and message like '%host directory%'`,
  );
  assert.equal(
    items.rows.length,
    1,
    "the report has to say it was a host directory",
  );
});

test("a config file that came across as a project file is not reported lost", async () => {
  await db.execute(
    "update app_volumes set type = 'app', project_path = 'config.json', host_path = null where volume_id = 'vol_bind'",
  );
  await seedMigrationHostServer();
  const runId = await openRun();

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(
    res.notes.some((n) => n.includes("was not copied")),
    false,
    res.notes.join(" | "),
  );
});

test("a bind mount that names a FILE copies the file, not what surrounds it", async () => {
  state.extraWebMounts.push({
    Type: "bind",
    Source: "/srv/site/nginx.conf",
    Destination: "/etc/nginx/nginx.conf",
  });
  await db.insert(appVolumesTable).values({
    appId: "prj_web",
    position: 2,
    volumeId: "vol_file",
    type: "host",
    name: "nginx-conf",
    service: null,
    projectPath: null,
    hostPath: "/srv/site/nginx.conf",
    mountPath: "/etc/nginx/nginx.conf",
    readOnly: false,
    propagation: null,
  });
  state.hostFiles = {
    srv_migration_host: { "/srv/site/nginx.conf": CONFIG_DIR },
  };
  await seedMigrationHostServer();
  const runId = await openRun();
  state.agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(res.failed, 0, JSON.stringify(res));
  assert.equal(res.moved, 3, JSON.stringify(res));
  assert.deepEqual(
    state.hostFiles[SERVER_1]?.["/srv/site/nginx.conf"],
    CONFIG_DIR,
  );
  assert.equal(
    state.agentCalls.some((c) => c.endsWith(":/srv/site")),
    false,
    state.agentCalls.join(" | "),
  );
});

// An agent that does not know the flag would create a DIRECTORY of that name and the stack
// would come back up on it - broken, and reported as copied.
test("a file the destination agent cannot take is refused, never guessed", async () => {
  state.agentCapabilities = [];
  state.extraWebMounts.push({
    Type: "bind",
    Source: "/srv/site/nginx.conf",
    Destination: "/etc/nginx/nginx.conf",
  });
  await db.insert(appVolumesTable).values({
    appId: "prj_web",
    position: 2,
    volumeId: "vol_file",
    type: "host",
    name: "nginx-conf",
    service: null,
    projectPath: null,
    hostPath: "/srv/site/nginx.conf",
    mountPath: "/etc/nginx/nginx.conf",
    readOnly: false,
    propagation: null,
  });
  state.hostFiles = {
    srv_migration_host: { "/srv/site/nginx.conf": CONFIG_DIR },
  };
  await seedMigrationHostServer();
  const runId = await openRun();
  state.agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(res.failed, 1, JSON.stringify(res));
  assert.ok(
    res.notes.some((n) => n.includes("too old")),
    res.notes.join(" | "),
  );
  assert.equal(state.hostPaths[SERVER_1]?.["/srv/site/nginx.conf"], undefined);
  assert.equal(state.hostFiles[SERVER_1]?.["/srv/site/nginx.conf"], undefined);
});

test("a system file a stack binds is not data, and is never even read", async () => {
  for (const p of ["/etc/localtime", "/etc/timezone", "/etc/resolv.conf"])
    state.extraWebMounts.push({ Type: "bind", Source: p, Destination: p });
  await db.insert(appVolumesTable).values(
    ["/etc/localtime", "/etc/timezone", "/etc/resolv.conf"].map((p, i) => ({
      appId: "prj_web",
      position: 2 + i,
      volumeId: `vol_sys_${i}`,
      type: "host" as const,
      name: `sys-${i}`,
      service: null,
      projectPath: null,
      hostPath: p,
      mountPath: p,
      readOnly: true,
      propagation: null,
    })),
  );
  await seedMigrationHostServer();
  const runId = await openRun();
  state.agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(res.failed, 0, JSON.stringify(res));
  assert.equal(
    state.agentCalls.some((c) => c.includes("/etc/localtime")),
    false,
    state.agentCalls.join(" | "),
  );
  const items = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' and message like '%/etc/localtime%'`,
  );
  assert.deepEqual(
    items.rows.map((r) => r.message),
    [],
    "a system file is not something to report on",
  );
});
