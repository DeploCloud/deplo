import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  appVolumes as appVolumesTable,
  databases as databasesTable,
  environments as environmentsTable,
  projects as projectsTable,
} from "../db/schema/control-plane";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  TRUNCATE_IDENTITY,
  USER_1,
} from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "./app-graph-test-helpers";
import {
  __setDokployFetchForTest,
  __resetDokployFetchForTest,
} from "../dokploy/client";
import { beginDokployImport } from "./dokploy-import";
import { moveDokployServiceData, planDokployDataMove } from "./dokploy-data";

/**
 * The data cutover, against a fake Dokploy.
 *
 * What is testable here is everything up to the byte copy: which services can
 * still be moved, which volume goes into which, and the refusals. The copy itself
 * is two agent RPCs and this repo has no `connectAgent` seam (the same note is in
 * `databases.test.ts`), so it is covered by the manual end-to-end instead — which
 * is also why the ORDER matters and is asserted: nothing on the source may be
 * stopped until every check has passed.
 */

let db: TestDb;
let pg: PGlite;

const CONNECT = { url: "https://dokploy.acme.test", apiKey: "dk_test_key" };

/** Every procedure the fake was asked for, in order. */
let calls: string[] = [];

const PROJECT_TREE = [
  {
    projectId: "dok-prj-blink",
    name: "Blink",
    environments: [
      {
        environmentId: "dok-env-prod",
        name: "production",
        isDefault: true,
        applications: [
          {
            applicationId: "dok-app-web",
            name: "blink-web",
            appName: "blink-web-abc",
            serverId: null,
          },
          {
            applicationId: "dok-app-ghost",
            name: "never-imported",
            appName: "ghost-xyz",
            serverId: null,
          },
        ],
        compose: [],
        postgres: [
          {
            postgresId: "dok-pg-1",
            name: "blink-db",
            appName: "blink-db-abc",
            serverId: null,
          },
        ],
      },
    ],
  },
];

/** `docker inspect` output per container, keyed by container id. */
const INSPECT: Record<string, unknown> = {
  "ct-web": {
    Name: "/blink-web-abc",
    State: { Running: true },
    Mounts: [
      { Type: "volume", Name: "blink-web-abc_uploads", Destination: "/app/uploads" },
      { Type: "bind", Source: "/etc/dokploy/x", Destination: "/app/config.json" },
    ],
  },
  "ct-db": {
    Name: "/blink-db-abc",
    State: { Running: true },
    Mounts: [
      {
        Type: "volume",
        Name: "blink-db-abc_data",
        // Postgres 18's own default, which is NOT where Deplo mounts it.
        Destination: "/var/lib/postgresql/18/docker",
      },
    ],
  },
};

/** Which containers each `appName` has. */
const CONTAINERS: Record<string, { containerId: string; name: string; state: string }[]> =
  {
    "blink-web-abc": [
      { containerId: "ct-web", name: "blink-web-abc.1", state: "running" },
    ],
    "blink-db-abc": [{ containerId: "ct-db", name: "blink-db-abc.1", state: "running" }],
    "ghost-xyz": [],
  };

function fakeDokploy() {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const procedure = url.pathname.replace(/^\/api\//, "");
    calls.push(procedure);
    assert.equal((init?.headers as Record<string, string>)["x-api-key"], CONNECT.apiKey);

    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (procedure === "project.all") return json(PROJECT_TREE);
    if (procedure === "docker.getContainersByAppLabel")
      return json(CONTAINERS[url.searchParams.get("appName") ?? ""] ?? []);
    if (procedure === "docker.getConfig")
      return json(INSPECT[url.searchParams.get("containerId") ?? ""] ?? {});
    if (procedure.endsWith(".stop")) return json({ ok: true });
    return new Response("not found", { status: 404 });
  };
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetDokployFetchForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await db.execute(TRUNCATE_PROJECT_GRAPH);
  await db.execute(TRUNCATE_IDENTITY);
  await db.execute("truncate table dokploy_imports cascade;");
  await db.execute("truncate table projects, environments cascade;");
  await db.execute("truncate table databases cascade;");
  await seedIdentity(db);
  await seedServer(db);
  __setDokployFetchForTest(fakeDokploy());
  calls = [];

  // The state an import leaves behind: the project, its production environment,
  // the app, one managed volume, and the database.
  await db.insert(projectsTable).values({
    id: "prc_blink",
    teamId: TEAM_A,
    name: "Blink",
    slug: "blink",
    color: null,
    ownerUserId: USER_1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await db.insert(environmentsTable).values({
    id: "environ_prod",
    projectId: "prc_blink",
    name: "production",
    slug: "production",
    kind: "production",
    isDefault: true,
    gitBranch: "",
    position: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  await seedApp(db, {
    id: "prj_web",
    teamId: TEAM_A,
    slug: "blink-web",
    projectId: "prc_blink",
    environmentId: "environ_prod",
  });
  await db
    .execute("update apps set name = 'blink-web' where id = 'prj_web'");
  await db.insert(appVolumesTable).values({
    appId: "prj_web",
    position: 0,
    volumeId: "vol_uploads",
    type: "named",
    name: "uploads",
    service: null,
    projectPath: null,
    hostPath: null,
    mountPath: "/app/uploads",
    readOnly: false,
    propagation: null,
  });
  await db.insert(databasesTable).values({
    id: "db_blink",
    teamId: TEAM_A,
    name: "blink-db",
    type: "postgres",
    version: "16",
    host: "db-blink-db",
    port: 5432,
    username: "app",
    dbName: "blink",
    connectionStringEnc: "v1..x.y.z",
    status: "running",
    serverId: SERVER_1,
    exposedPublicly: false,
    exposedPort: null,
    cronEnabled: false,
    sizeMb: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
});

function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
}

/* ---- the plan -------------------------------------------------------- */

test("the plan pairs an imported app's volume with the one Deplo will mount", async () => {
  const plan = await asOwner(() => planDokployDataMove(CONNECT));
  const web = plan.find((s) => s.sourceName === "blink-web");
  assert.ok(web, JSON.stringify(plan.map((s) => s.sourceName)));
  assert.equal(web.path, "Blink / production / blink-web");
  assert.equal(web.targetKind, "app");
  assert.equal(web.targetId, "prj_web");
  assert.equal(web.running, true);
  assert.deepEqual(
    web.volumes.map((v) => `${v.sourceVolume}->${v.targetVolume}@${v.mountPath}`),
    ["blink-web-abc_uploads->deplo-blink-web-uploads@/app/uploads"],
  );
  // The bind mount is not a volume and is not offered as one.
  assert.equal(web.volumes.length, 1);
});

test("a service that was never imported is not listed at all", async () => {
  const plan = await asOwner(() => planDokployDataMove(CONNECT));
  assert.equal(
    plan.some((s) => s.sourceName === "never-imported"),
    false,
  );
});

test("a database pairs 1:1 and says the data directory moved", async () => {
  const plan = await asOwner(() => planDokployDataMove(CONNECT));
  const database = plan.find((s) => s.targetKind === "database");
  assert.ok(database);
  assert.equal(database.targetId, "db_blink");
  assert.equal(database.volumes.length, 1);
  assert.equal(database.volumes[0].targetVolume, "deplo-db-blink-db_db-blink-db-data");
  assert.match(database.volumes[0].note!, /data directory moved/);
});

test("the plan reads both sides and writes to neither", async () => {
  await asOwner(() => planDokployDataMove(CONNECT));
  assert.equal(
    calls.some((p) => p.endsWith(".stop")),
    false,
    "planning must never stop anything",
  );
  assert.ok(calls.includes("docker.getConfig"));
});

/* ---- the refusals ---------------------------------------------------- */

test("nothing is stopped until Deplo knows which server holds the data", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: CONNECT.url }));
  calls = [];
  await assert.rejects(
    () =>
      asOwner(() =>
        moveDokployServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-web",
          // The Dokploy host is unmapped: pointing the copy at the wrong machine
          // would read a volume that is not there and overwrite real data with an
          // empty archive.
          servers: [],
        }),
      ),
    /which of its servers runs that Dokploy host/,
  );
  assert.equal(
    calls.some((p) => p.endsWith(".stop")),
    false,
    "the source must still be running after a refusal",
  );
});

test("a service that is not in this team cannot be moved into it", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: CONNECT.url }));
  await assert.rejects(
    () =>
      asOwner(() =>
        moveDokployServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-ghost",
          servers: [{ from: "", to: SERVER_1 }],
        }),
      ),
    /not in this team/,
  );
});

test("a service Dokploy no longer has is refused before anything else", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: CONNECT.url }));
  await assert.rejects(
    () =>
      asOwner(() =>
        moveDokployServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-vanished",
          servers: [{ from: "", to: SERVER_1 }],
        }),
      ),
    /no longer on the Dokploy instance/,
  );
});

test("a run from another team is not a place to write a report", async () => {
  const runId = await asOwner(() => beginDokployImport({ url: CONNECT.url }));
  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
        moveDokployServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-web",
          servers: [{ from: "", to: SERVER_1 }],
        }),
      ),
    /scoped to a team the user no longer belongs to|does not belong to this team/,
  );
});
