// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

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
  environments as environmentsTable,
  migrationRunItems as itemsTable,
  projects as projectsTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import {
  seedIdentity,
  TEAM_A,
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
  __setMigrationFetchForTest,
  __resetMigrationFetchForTest,
} from "../migration/transport";
import { __resetCoolifyRateLimitForTest } from "../migration/coolify/client";
import { __setAgentConnectorForTest } from "../infra/agent-client";
import { beginMigration } from "./migration-import";
import {
  moveMigrationServiceData,
  planMigrationDataMove,
} from "./migration-data";
import { EMPTY_TAR_GZ, tarGzOf } from "../test/tar-fixture";

/**
 * The data cutover against a fake Coolify.
 *
 * The difference that matters: Coolify's own storage rows already carry the real
 * volume name on the host, so nothing is inspected and nothing is synthesised -
 * and its stop is a queued job, so the cutover has to WAIT for it.
 */

let db: TestDb;
let pg: PGlite;

const CONNECT = {
  url: "https://coolify.acme.test",
  apiKey: "3|abcdefghijklmnopqrstuvwxyz012345",
  kind: "coolify" as const,
};

let calls: string[] = [];
/** How many status reads it takes before the app reports itself stopped. */
let stopsAfter = 1;
let statusReads = 0;
let running = true;

const STORAGES: Record<string, unknown> = {
  "app-web": {
    persistent_storages: [
      { uuid: "s1", name: "web-uploads-app-web", mount_path: "/app/uploads" },
      {
        uuid: "s2",
        mount_path: "/app/config.json",
        host_path: "/data/coolify/applications/app-web/config.json",
      },
    ],
    file_storages: [],
  },
};

function fakeCoolify() {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    if (!url.pathname.startsWith("/api/v1/"))
      return new Response("not found", { status: 404 });
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    calls.push(`${init?.method ?? "GET"} ${path}`);
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (path === "projects")
      return json([{ uuid: "prj-blink", name: "Blink" }]);
    if (path === "projects/prj-blink/environments")
      return json([{ id: 2, uuid: "env-prod", name: "production" }]);
    if (path === "projects/prj-blink/envs") return json([]);
    if (path === "projects/prj-blink/environments/production/envs")
      return json([]);
    if (path === "servers")
      return json([
        {
          id: 0,
          uuid: "srv-local",
          name: "localhost",
          ip: "host.docker.internal",
        },
      ]);
    if (path === "servers/srv-local/resources")
      return json([{ uuid: "app-web", name: "web", type: "application" }]);
    if (path === "applications")
      return json([
        {
          uuid: "app-web",
          name: "web",
          environment_id: 2,
          build_pack: "nixpacks",
          status: running ? "running:healthy" : "exited",
        },
      ]);
    if (path === "services" || path === "databases") return json([]);

    const single = /^(applications|services|databases)\/([^/]+)$/.exec(path);
    if (single) {
      if (single[2] !== "app-web")
        return new Response("not found", { status: 404 });
      statusReads += 1;
      if (statusReads >= stopsAfter) running = false;
      return json({
        uuid: "app-web",
        name: "web",
        environment_id: 2,
        build_pack: "nixpacks",
        status: running ? "running:healthy" : "exited",
      });
    }
    if (/\/storages$/.test(path))
      return json(STORAGES[path.split("/")[1]] ?? {});
    if (/\/envs$/.test(path)) return json([]);
    if (/\/stop$/.test(path)) return json({ message: "queued" });
    return new Response("not found", { status: 404 });
  };
}

/* ---- the fake agent -------------------------------------------------- */

let agentCalls: string[] = [];
let volumes: Record<string, Record<string, Buffer>> = {};
let hostPaths: Record<string, Record<string, Buffer>> = {};
const EMPTY_ARCHIVE = EMPTY_TAR_GZ;

function fakeAgent(serverId: string) {
  const say = (verb: string, arg: string) =>
    agentCalls.push(`${serverId}:${verb}:${arg}`);
  return {
    async hello() {
      say("hello", "");
      return {
        contractVersion: 1,
        dockerAvailable: true,
        capabilities: [],
        version: "1.0.0",
      };
    },
    async *exportVolume(name: string) {
      say("export", name);
      yield volumes[serverId]?.[name] ?? EMPTY_ARCHIVE;
    },
    async importVolume(
      name: string,
      wipeFirst: boolean,
      chunks: AsyncIterable<Buffer>,
    ) {
      say("import", name);
      if (wipeFirst) say("wipe", name);
      const parts: Buffer[] = [];
      for await (const ch of chunks) parts.push(ch);
      volumes[serverId] ??= {};
      volumes[serverId][name] = Buffer.concat(parts);
      return { ok: true, error: "" };
    },
    async *exportHostPath(path: string) {
      say("export-path", path);
      yield hostPaths[serverId]?.[path] ?? EMPTY_ARCHIVE;
    },
    async importHostPath(
      path: string,
      wipeFirst: boolean,
      chunks: AsyncIterable<Buffer>,
    ) {
      say("import-path", path);
      if (wipeFirst) say("wipe-path", path);
      const parts: Buffer[] = [];
      for await (const ch of chunks) parts.push(ch);
      hostPaths[serverId] ??= {};
      hostPaths[serverId][path] = Buffer.concat(parts);
      return { ok: true, error: "" };
    },
    async stopStack(slug: string) {
      say("stop", slug);
      return { ok: true, error: "" };
    },
    async startStack(slug: string) {
      say("start", slug);
      return { ok: true, error: "" };
    },
    async listInstances() {
      return [];
    },
    async exec() {
      return { stdout: "", stderr: "", code: 0, rawMode: false };
    },
    close() {},
  };
}

async function openRun(): Promise<string> {
  const runId = await asOwner(() =>
    beginMigration({ url: CONNECT.url, kind: "coolify" }),
  );
  await db.insert(itemsTable).values({
    id: "dimi_seed_0",
    runId,
    path: "Blink / production / web",
    sourceKind: "application",
    sourceName: "web",
    sourceId: "app-web",
    outcome: "created",
    targetKind: "app",
    targetId: "prj_web",
    message: null,
  });
  return runId;
}

/** The Deplo server sitting at the Coolify address - derived, never chosen. */
async function seedPanelHost(): Promise<void> {
  await db
    .insert(serversTable)
    .values({
      id: "srv_migration_host",
      name: "coolify-host",
      host: "coolify.acme.test",
      type: "remote",
      status: "online",
      ip: "coolify.acme.test",
      dockerVersion: "27",
      traefikEnabled: true,
      cpuCores: 4,
      memoryMb: 8192,
      diskGb: 100,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .onConflictDoNothing();
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetMigrationFetchForTest();
  __resetCoolifyRateLimitForTest();
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await db.execute(TRUNCATE_PROJECT_GRAPH);
  await db.execute(TRUNCATE_IDENTITY);
  await db.execute("truncate table migration_runs cascade;");
  await db.execute("truncate table projects, environments cascade;");
  await seedIdentity(db);
  await seedServer(db);
  __setMigrationFetchForTest(fakeCoolify());
  __resetCoolifyRateLimitForTest();
  calls = [];
  agentCalls = [];
  statusReads = 0;
  stopsAfter = 1;
  running = true;
  hostPaths = {
    srv_migration_host: {
      "/data/coolify/applications/app-web/config.json": tarGzOf(2048, 5),
    },
  };
  volumes = {
    srv_migration_host: { "web-uploads-app-web": tarGzOf(4096, 7) },
    [SERVER_1]: { "deplo-blink-web-uploads": tarGzOf(64, 1) },
  };
  __setAgentConnectorForTest(
    async (serverId) =>
      fakeAgent(serverId) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );

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
  await db.execute("update apps set name = 'web' where id = 'prj_web'");
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
  await db.insert(appVolumesTable).values({
    appId: "prj_web",
    position: 1,
    volumeId: "vol_bind",
    type: "host",
    name: "config",
    service: null,
    projectPath: null,
    hostPath: "/data/coolify/applications/app-web/config.json",
    mountPath: "/app/config.json",
    readOnly: false,
    propagation: null,
  });
});

function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
}

/* ---- the plan -------------------------------------------------------- */

test("the plan pairs by the path inside the container", async () => {
  await seedPanelHost();
  const runId = await openRun();
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  const web = plan.find((s) => s.sourceName === "web");
  assert.ok(web);
  assert.equal(web.targetId, "prj_web");
  assert.deepEqual(
    web.volumes.map(
      (v) => `${v.sourceVolume}->${v.targetVolume}@${v.mountPath}`,
    ),
    [
      "web-uploads-app-web->deplo-blink-web-uploads@/app/uploads",
      // The bind mount is listed too: same path on both sides, moved by a
      // different RPC behind a different permission.
      "/data/coolify/applications/app-web/config.json->/data/coolify/applications/app-web/config.json@/app/config.json",
    ],
  );
});

// Coolify already knows the volume's real name, so the plan never asks the host
// what a container is mounting.
test("planning inspects no container, because it does not have to", async () => {
  await seedPanelHost();
  const runId = await openRun();
  await asOwner(() => planMigrationDataMove({ ...CONNECT, runId }));
  assert.equal(
    calls.some((c) => c.includes("docker") || c.includes("inspect")),
    false,
  );
  assert.ok(calls.some((c) => c === "GET applications/app-web/storages"));
});

test("a service already stopped is still planned", async () => {
  running = false;
  await seedPanelHost();
  const runId = await openRun();
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  const web = plan.find((s) => s.sourceName === "web")!;
  assert.equal(web.running, false);
  // Stopped is the state a volume has to be READ in, so nothing is dropped.
  assert.equal(web.volumes.length, 2);
});

/* ---- the move -------------------------------------------------------- */

test("the volume crosses, the source is stopped first, and the target is wiped", async () => {
  await seedPanelHost();
  const runId = await openRun();
  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "app-web",
    }),
  );
  assert.equal(res.failed, 0);
  assert.ok(res.moved >= 1);

  // Stopped over there BEFORE anything was read here.
  const stopIndex = calls.findIndex((c) => c.endsWith("/stop"));
  const exportIndex = agentCalls.findIndex((c) => c.includes(":export:"));
  assert.ok(stopIndex >= 0);
  assert.ok(exportIndex >= 0);

  assert.ok(
    agentCalls.includes("srv_migration_host:export:web-uploads-app-web"),
    agentCalls.join(","),
  );
  assert.ok(agentCalls.includes(`${SERVER_1}:wipe:deplo-blink-web-uploads`));
  assert.deepEqual(
    volumes[SERVER_1]["deplo-blink-web-uploads"],
    tarGzOf(4096, 7),
    "the bytes that arrived are the ones that left",
  );
});

// Coolify's stop returns 200 the moment the job is QUEUED. Reading a volume while
// its container is still writing is the one thing a cutover must never do.
test("the stop waits for the container to actually be down", async () => {
  stopsAfter = 3;
  await seedPanelHost();
  const runId = await openRun();
  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "app-web",
    }),
  );
  // It polled rather than trusting the 200.
  assert.ok(statusReads >= 3, `only ${statusReads} status reads`);
  const lastStatusRead = calls.lastIndexOf("GET applications/app-web");
  const stopIndex = calls.findIndex((c) => c.endsWith("/stop"));
  assert.ok(lastStatusRead > stopIndex);
});

test("a bind mount under the panel's data directory crosses too", async () => {
  await seedPanelHost();
  const runId = await openRun();
  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "app-web",
    }),
  );
  assert.ok(
    agentCalls.some((c) => c.includes("export-path:/data/coolify/")),
    agentCalls.join(","),
  );
});

// ADR-0025: the host the data is READ from is derived from the machine's own
// address. Naming one would be an instruction to copy any volume off any host.
test("the source host is derived, never taken from the caller", async () => {
  const runId = await openRun();
  // No server registered at the panel's address: the cutover refuses rather than
  // reaching for a host somebody might name.
  await assert.rejects(
    asOwner(() =>
      moveMigrationServiceData({
        ...CONNECT,
        runId,
        sourceKind: "application",
        sourceId: "app-web",
      }),
    ),
    /no agent on the machine/,
  );
  assert.equal(
    agentCalls.some((c) => c.includes(":export:")),
    false,
  );
});

test("a service this run did not create cannot be reached", async () => {
  await seedPanelHost();
  const runId = await openRun();
  await assert.rejects(
    asOwner(() =>
      moveMigrationServiceData({
        ...CONNECT,
        runId,
        sourceKind: "application",
        sourceId: "app-ghost",
      }),
    ),
  );
});
