import { encryptSecret } from "../../crypto";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-pg-"));

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { runWithIdentity } from "../../auth/request-context";
import { appVolumes as appVolumesTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import {
  environments as environmentsTable,
  projects as projectsTable,
} from "../../db/schema/control-plane/projects";
import {
  seedIdentity,
  TEAM_A,
  TRUNCATE_IDENTITY,
  USER_1,
} from "../identity-test-helpers";
import {
  seedApp,
  seedServer,
  SERVER_1,
  TRUNCATE_PROJECT_GRAPH,
} from "../app-graph-test-helpers";
import {
  __setMigrationFetchForTest,
  __resetMigrationFetchForTest,
} from "../../migration/transport";
import { migrationRunItems as itemsTable } from "../../db/schema/control-plane/migration";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { beginMigration } from "../migration-import/run-lifecycle";
import { EMPTY_TAR_GZ, tarGzOf } from "../../test/tar-fixture";

let db: TestDb;
let pg: PGlite;

export const CONNECT = {
  url: "https://dokploy.acme.test",
  apiKey: "dk_test_key",
};

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
            applicationStatus: "done",
          },
          {
            applicationId: "dok-app-ghost",
            name: "never-imported",
            applicationStatus: "done",
          },
        ],
        compose: [{ composeId: "dok-cmp-1" }],
        postgres: [{ postgresId: "dok-pg-1" }],
      },
    ],
  },
];

const DETAILS: Record<string, unknown> = {
  "dok-app-web": {
    applicationId: "dok-app-web",
    name: "blink-web",
    appName: "blink-web-abc",
    serverId: null,
  },
  "dok-app-ghost": {
    applicationId: "dok-app-ghost",
    name: "never-imported",
    appName: "ghost-xyz",
    serverId: null,
  },
  "dok-cmp-1": {
    composeId: "dok-cmp-1",
    name: "blink-stack",
    appName: "blinkstack-abc",
    composeFile: "",
    serverId: null,
  },
  "dok-pg-1": {
    postgresId: "dok-pg-1",
    name: "blink-db",
    appName: "blink-db-abc",
    dockerImage: "postgres:16",
    serverId: null,
  },
};

const INSPECT: Record<string, unknown> = {
  "ct-web": {
    Name: "/blink-web-abc",
    State: { Running: true },
    Mounts: [
      {
        Type: "volume",
        Name: "blink-web-abc_uploads",
        Destination: "/app/uploads",
      },
      {
        Type: "bind",
        Source: "/etc/dokploy/x",
        Destination: "/app/config.json",
      },
    ],
  },
  "ct-db": {
    Name: "/blink-db-abc",
    State: { Running: true },
    Mounts: [
      {
        Type: "volume",
        Name: "blink-db-abc_data",
        Destination: "/var/lib/postgresql/18/docker",
      },
    ],
  },
};

export const CONTAINERS: Record<
  string,
  { containerId: string; name: string; state: string }[]
> = {
  "blink-web-abc": [
    { containerId: "ct-web", name: "blink-web-abc.1", state: "running" },
  ],
  "blink-db-abc": [
    { containerId: "ct-db", name: "blink-db-abc.1", state: "running" },
  ],
  "ghost-xyz": [],
  "blinkstack-abc": [],
};

const RESOLVED_COMPOSE = [
  "services:",
  "  api:",
  "    image: acme/api",
  "    volumes:",
  "      - store:/var/lib/store",
  "volumes:",
  "  store: {}",
  "",
].join("\n");

const EMPTY_ARCHIVE = EMPTY_TAR_GZ;
export const UPLOADS = tarGzOf(4096, 7);
export const DB_DATA = tarGzOf(8192, 9);
export const CONFIG_DIR = tarGzOf(2048, 5);
const STACK_STORE = tarGzOf(3072, 6);
const LANDED_UPLOADS = tarGzOf(64, 1);
const LANDED_DB = tarGzOf(64, 2);

// Every knob the two fakes read lives here so a test can set it: an exported `let`
// cannot be assigned from the file that imports it.
export const state = {
  calls: [] as string[],
  agentCalls: [] as string[],
  volumes: {} as Record<string, Record<string, Buffer>>,
  hostPaths: {} as Record<string, Record<string, Buffer>>,
  hostFiles: {} as Record<string, Record<string, Buffer>>,
  agentCapabilities: ["host-path-copy.file"] as string[],
  unreachableAgents: new Set<string>(),
  hostDiesMidCopy: new Set<string>(),
  importRefusal: "",
  notFoundVolumes: new Set<string>(),
  sourceRunning: true,
  startRefusesNoContainer: false,
  stopRefusal: "",
  extraWebMounts: [] as unknown[],
};

function fakeSource() {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const procedure = url.pathname.replace(/^\/api\//, "");
    state.calls.push(procedure);
    assert.equal(
      (init?.headers as Record<string, string>)["x-api-key"],
      CONNECT.apiKey,
    );

    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    if (procedure === "project.all") return json(PROJECT_TREE);
    if (procedure.endsWith(".one")) {
      const id = [...url.searchParams.values()][0] ?? "";
      const row = DETAILS[id];
      return row ? json(row) : new Response("not found", { status: 404 });
    }
    if (procedure === "compose.getConvertedCompose")
      return json(RESOLVED_COMPOSE);
    if (procedure === "docker.getContainersByAppLabel")
      return json(CONTAINERS[url.searchParams.get("appName") ?? ""] ?? []);
    if (procedure === "docker.getConfig") {
      const id = url.searchParams.get("containerId") ?? "";
      const row = INSPECT[id] as { Mounts?: unknown[] } | undefined;
      return json(
        row
          ? {
              ...row,
              State: { Running: state.sourceRunning },
              Mounts: [
                ...(row.Mounts ?? []),
                ...(id === "ct-web" ? state.extraWebMounts : []),
              ],
            }
          : {},
      );
    }
    if (procedure.endsWith(".stop")) {
      if (state.stopRefusal)
        return new Response(JSON.stringify({ message: state.stopRefusal }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      return json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  };
}

function fakeAgent(serverId: string) {
  const say = (verb: string, arg: string) =>
    state.agentCalls.push(`${serverId}:${verb}:${arg}`);
  return {
    async hello() {
      say("hello", "");
      if (state.unreachableAgents.has(serverId))
        throw new Error("14 UNAVAILABLE: No connection established");
      return {
        contractVersion: 1,
        dockerAvailable: true,
        capabilities: state.agentCapabilities,
        version: "1.0.0",
      };
    },
    async *exportVolume(name: string) {
      say("export", name);
      if (state.notFoundVolumes.has(name))
        throw Object.assign(
          new Error(`5 NOT_FOUND: docker: no such volume: ${name}`),
          { code: 5 },
        );
      if (state.hostDiesMidCopy.has(serverId)) {
        yield UPLOADS.subarray(0, 16);
        throw Object.assign(new Error("14 UNAVAILABLE: read ECONNRESET"), {
          code: 14,
        });
      }
      yield state.volumes[serverId]?.[name] ?? EMPTY_ARCHIVE;
    },
    async importVolume(
      name: string,
      wipeFirst: boolean,
      chunks: AsyncIterable<Buffer>,
    ) {
      say("import", name);
      if (wipeFirst) {
        say("wipe", name);
        delete state.volumes[serverId]?.[name];
      }
      const parts: Buffer[] = [];
      for await (const c of chunks) parts.push(c);
      state.volumes[serverId] ??= {};
      state.volumes[serverId][name] = Buffer.concat(parts);
      if (state.importRefusal) return { ok: false, error: state.importRefusal };
      return { ok: true, error: "" };
    },
    async volumeUsage(names: string[]) {
      say("usage", names.join(","));
      const here = state.volumes[serverId] ?? {};
      return new Map(
        names
          .filter((n) => n in here && !state.notFoundVolumes.has(n))
          .map((n) => [n, 1024]),
      );
    },
    async *exportHostPath(path: string, allowFile = false) {
      say(allowFile ? "export-file" : "export-path", path);
      const file = state.hostFiles[serverId]?.[path];
      if (file) {
        if (!allowFile) throw new Error(`${path} is a file, not a directory`);
        yield file;
        return;
      }
      yield state.hostPaths[serverId]?.[path] ?? EMPTY_ARCHIVE;
    },
    async importHostPath(
      path: string,
      wipeFirst: boolean,
      chunks: AsyncIterable<Buffer>,
      file = false,
    ) {
      say(file ? "import-file" : "import-path", path);
      if (wipeFirst) say("wipe-path", path);
      const parts: Buffer[] = [];
      for await (const c of chunks) parts.push(c);
      const into = file
        ? (state.hostFiles[serverId] ??= {})
        : (state.hostPaths[serverId] ??= {});
      into[path] = Buffer.concat(parts);
      return { ok: true, error: "" };
    },
    async stopStack(slug: string) {
      say("stop", slug);
      return { ok: true, error: "" };
    },
    async startStack(slug: string) {
      say("start", slug);
      if (state.startRefusesNoContainer) {
        state.startRefusesNoContainer = false;
        throw new Error(`service "${slug}" has no container to start`);
      }
      return { ok: true, error: "" };
    },
    async reroute(input: { slug: string }) {
      say("reroute", input.slug);
      return { ok: true, error: "" };
    },
    async listInstances(_id: string, slug: string) {
      return [
        {
          name: slug,
          service: slug,
          image: "postgres:16",
          running: true,
          exposed: false,
          user: "postgres",
          workdir: "/",
          openStdin: false,
          tty: false,
          state: "running",
          health: "healthy",
          restartCount: 0,
        },
      ];
    },
    async exec() {
      return { stdout: "7\n", stderr: "", code: 0, rawMode: false };
    },
    close() {},
  };
}

export async function seedRunItems(
  runId: string,
  rows: {
    sourceKind: string;
    sourceId: string;
    sourceName: string;
    targetKind: string;
    targetId: string;
    outcome?: string;
  }[],
): Promise<void> {
  for (const [i, r] of rows.entries())
    await db.insert(itemsTable).values({
      id: `dimi_seed_${runId.slice(-6)}_${i}_${r.sourceId}`,
      runId,
      path: `Blink / production / ${r.sourceName}`,
      sourceKind: r.sourceKind,
      sourceName: r.sourceName,
      sourceId: r.sourceId,
      outcome: r.outcome ?? "created",
      targetKind: r.targetKind,
      targetId: r.targetId,
      message: null,
    });
}

export async function openRun(): Promise<string> {
  const runId = await asOwner(() => beginMigration({ url: CONNECT.url }));
  await seedRunItems(runId, [
    {
      sourceKind: "application",
      sourceId: "dok-app-web",
      sourceName: "blink-web",
      targetKind: "app",
      targetId: "prj_web",
    },
    {
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
      sourceName: "blink-db",
      targetKind: "database",
      targetId: "db_blink",
    },
    {
      sourceKind: "compose",
      sourceId: "dok-cmp-1",
      sourceName: "blink-stack",
      targetKind: "app",
      targetId: "prj_stack",
    },
  ]);
  return runId;
}

export async function seedMigrationHostServer(): Promise<void> {
  await db
    .insert(serversTable)
    .values({
      id: "srv_migration_host",
      name: "dokploy-host",
      host: "dokploy.acme.test",
      type: "remote",
      status: "online",
      ip: "dokploy.acme.test",
      dockerVersion: "27",
      traefikEnabled: true,
      cpuCores: 4,
      memoryMb: 8192,
      diskGb: 100,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .onConflictDoNothing();
}

export function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
}

export async function openHarness(): Promise<TestDb> {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  return db;
}

export async function closeHarness(): Promise<void> {
  __resetMigrationFetchForTest();
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
}

export async function resetHarness(): Promise<void> {
  await db.execute(TRUNCATE_PROJECT_GRAPH);
  await db.execute(TRUNCATE_IDENTITY);
  await db.execute("truncate table migration_runs cascade;");
  await db.execute("truncate table projects, environments cascade;");
  await db.execute("truncate table databases cascade;");
  await seedIdentity(db);
  await seedServer(db);
  __setMigrationFetchForTest(fakeSource());
  state.calls = [];
  state.agentCalls = [];
  state.unreachableAgents.clear();
  state.hostDiesMidCopy.clear();
  state.importRefusal = "";
  state.notFoundVolumes = new Set();
  state.sourceRunning = true;
  state.startRefusesNoContainer = false;
  state.stopRefusal = "";
  state.hostPaths = {
    srv_migration_host: { "/etc/dokploy/x": CONFIG_DIR },
  };
  state.hostFiles = {};
  state.extraWebMounts = [];
  state.agentCapabilities = ["host-path-copy.file"];
  state.volumes = {
    srv_migration_host: {
      "blink-web-abc_uploads": UPLOADS,
      "blink-db-abc_data": DB_DATA,
      "blinkstack-abc_store": STACK_STORE,
    },
    [SERVER_1]: {
      "deplo-blink-web-uploads": LANDED_UPLOADS,
      "deplo-db-blink-db_db-blink-db-data": LANDED_DB,
    },
  };
  __setAgentConnectorForTest(
    async (serverId) =>
      fakeAgent(serverId) as unknown as Awaited<
        ReturnType<
          typeof import("../../infra/agent-client/connect").connectAgent
        >
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
  await db.execute("update apps set name = 'blink-web' where id = 'prj_web'");
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
    hostPath: "/etc/dokploy/x",
    mountPath: "/app/config.json",
    readOnly: false,
    propagation: null,
  });
  await seedApp(db, {
    id: "prj_stack",
    teamId: TEAM_A,
    slug: "blink-stack",
    projectId: "prc_blink",
    environmentId: "environ_prod",
    source: "compose",
    compose: RESOLVED_COMPOSE,
  });
  await db.execute(
    "update apps set name = 'blink-stack' where id = 'prj_stack'",
  );
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
    connectionStringEnc: encryptSecret(
      "postgres://app:pw@db-blink-db:5432/blink",
    ),
    status: "running",
    serverId: SERVER_1,
    exposedPublicly: false,
    exposedPort: null,
    cronEnabled: false,
    sizeMb: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}
