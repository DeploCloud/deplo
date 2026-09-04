import { encryptSecret } from "../crypto";
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
  __setMigrationFetchForTest,
  __resetMigrationFetchForTest,
} from "../migration/transport";
import {
  migrationRunItems as itemsTable,
  servers as serversTable,
} from "../db/schema/control-plane";
import { __setAgentConnectorForTest } from "../infra/agent-client";
import { beginMigration, finishMigration } from "./migration-import";
import {
  moveMigrationServiceData,
  planMigrationDataMove,
} from "./migration-data";
import { acceptDataCopyLoss } from "./data-copy";
import { startApp } from "./apps";
import { redeployDatabase, restartDatabase } from "./databases";
import { startDeployment } from "../deploy/build";
import { EMPTY_TAR_GZ, tarGzOf } from "../test/tar-fixture";

/**
 * The data cutover, against a fake Dokploy and a fake agent.
 */

let db: TestDb;
let pg: PGlite;

const CONNECT = { url: "https://dokploy.acme.test", apiKey: "dk_test_key" };

/** Every procedure the fake was asked for, in order. */
let calls: string[] = [];

/** What every fake agent advertises. A host-path copy of a single FILE is refused
 *  outright when the receiving agent does not, so a test can take it away. */
let agentCapabilities: string[] = ["host-path-copy.file"];

/** Servers whose agent refuses to answer us - the pre-flight's whole subject. */
const unreachableAgents = new Set<string>();

/** Servers that answer the pre-flight and then drop the copy half way through. */
const hostDiesMidCopy = new Set<string>();

const PROJECT_TREE = [
  {
    projectId: "dok-prj-blink",
    name: "Blink",
    environments: [
      {
        environmentId: "dok-env-prod",
        name: "production",
        isDefault: true,
        // Exactly what a real instance returns: an application carries an id, a
        // name and a status, and a DATABASE carries nothing but its id.
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

/** The detail rows - the only place `appName` and `serverId` exist. */
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
  // A stack built from a repository: Dokploy holds no `composeFile` for it, which
  // is what left it with "nothing to copy" once its containers were gone.
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

/** `docker inspect` output per container, keyed by container id. */
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
        // Postgres 18's own default, which is NOT where Deplo mounts it.
        Destination: "/var/lib/postgresql/18/docker",
      },
    ],
  },
};

/** Bind mounts added to `ct-web` by a single test. Reset between tests. */
let extraWebMounts: unknown[] = [];

/** Which containers each `appName` has. */
const CONTAINERS: Record<
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
  // Stopped: Dokploy scales a stack to zero, so there is nothing to inspect.
  "blinkstack-abc": [],
};

/** What `compose.getConvertedCompose` hands back - the file Dokploy would deploy. */
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

function fakeSource() {
  return async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const procedure = url.pathname.replace(/^\/api\//, "");
    calls.push(procedure);
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
              State: { Running: sourceRunning },
              Mounts: [
                ...(row.Mounts ?? []),
                ...(id === "ct-web" ? extraWebMounts : []),
              ],
            }
          : {},
      );
    }
    if (procedure.endsWith(".stop")) {
      if (stopRefusal)
        return new Response(JSON.stringify({ message: stopRefusal }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      return json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  };
}

/* ------------------------------------------------------------------ */
/* The fake agent                                                      */
/* ------------------------------------------------------------------ */

/** Everything the copy asked each host to do, in order: `<serverId>:<verb>:<arg>`. */
let agentCalls: string[] = [];
/** What each host holds. A volume that is ABSENT here is one `docker volume` would
 *  create empty on the spot - the exact shape that destroyed every import. */
let volumes: Record<string, Record<string, Buffer>> = {};
/** What each host has in a plain DIRECTORY, for the bind-mount half. */
let hostPaths: Record<string, Record<string, Buffer>> = {};
/** Host paths that are a FILE, not a directory - what the export refuses unless
 *  it is told a file is acceptable. Value is the archive of that one file. */
let hostFiles: Record<string, Record<string, Buffer>> = {};

/** A gzipped tar of an empty directory: the archive a missing volume produces. */
const EMPTY_ARCHIVE = EMPTY_TAR_GZ;
/** What each fixture holds. Real archives, because emptiness is read from an
 *  archive's entries and not from how many bytes it is. */
const UPLOADS = tarGzOf(4096, 7);
const DB_DATA = tarGzOf(8192, 9);
const CONFIG_DIR = tarGzOf(2048, 5);
const STACK_STORE = tarGzOf(3072, 6);
const LANDED_UPLOADS = tarGzOf(64, 1);
const LANDED_DB = tarGzOf(64, 2);

/** When set, every importVolume refuses with this message - a host that ran out
 *  of disk, a relay that died mid-stream. Reset between tests. */
let importRefusal = "";

/** Volumes the source host does not HAVE - what a service created and never
 *  started declares. The agent answers NOT_FOUND, not an empty archive. */
let notFoundVolumes = new Set<string>();

/** When false, the source's containers exist but nothing is running in them. */
let sourceRunning = true;

/** A database whose provisioning never finished: `start` finds no container. */
let startRefusesNoContainer = false;

/** Dokploy's own answer to `.stop` for a stack it never deployed: its 500. */
let stopRefusal = "";

function fakeAgent(serverId: string) {
  const say = (verb: string, arg: string) =>
    agentCalls.push(`${serverId}:${verb}:${arg}`);
  return {
    // The pre-flight. A migration source can be enrolled and still unreachable -
    // the agent enrols by calling home OUTBOUND, and a copy needs the opposite
    // direction - so the cutover asks before it stops anything.
    async hello() {
      say("hello", "");
      if (unreachableAgents.has(serverId))
        throw new Error("14 UNAVAILABLE: No connection established");
      return {
        contractVersion: 1,
        dockerAvailable: true,
        capabilities: agentCapabilities,
        version: "1.0.0",
      };
    },
    async *exportVolume(name: string) {
      say("export", name);
      if (notFoundVolumes.has(name))
        throw Object.assign(
          new Error(`5 NOT_FOUND: docker: no such volume: ${name}`),
          { code: 5 },
        );
      if (hostDiesMidCopy.has(serverId)) {
        // What a connection reset looks like by the time it reaches this code:
        // the gRPC status, not the socket error underneath it.
        yield UPLOADS.subarray(0, 16);
        throw Object.assign(new Error("14 UNAVAILABLE: read ECONNRESET"), {
          code: 14,
        });
      }
      // Docker CREATES a missing named volume rather than failing, so an export of
      // one that is not here answers with a complete, empty archive.
      yield volumes[serverId]?.[name] ?? EMPTY_ARCHIVE;
    },
    async importVolume(
      name: string,
      wipeFirst: boolean,
      chunks: AsyncIterable<Buffer>,
    ) {
      say("import", name);
      if (wipeFirst) {
        say("wipe", name);
        delete volumes[serverId]?.[name];
      }
      const parts: Buffer[] = [];
      for await (const c of chunks) parts.push(c);
      volumes[serverId] ??= {};
      volumes[serverId][name] = Buffer.concat(parts);
      if (importRefusal) return { ok: false, error: importRefusal };
      return { ok: true, error: "" };
    },
    // The pre-flight's OTHER half: the machine answers, but does it hold the
    // volumes? A name it does not have is simply absent from the answer.
    async volumeUsage(names: string[]) {
      say("usage", names.join(","));
      const here = volumes[serverId] ?? {};
      return new Map(
        names
          .filter((n) => n in here && !notFoundVolumes.has(n))
          .map((n) => [n, 1024]),
      );
    },
    async *exportHostPath(path: string, allowFile = false) {
      say(allowFile ? "export-file" : "export-path", path);
      const file = hostFiles[serverId]?.[path];
      if (file) {
        // The real agent's refusal, verbatim - it is what the caller matches on.
        if (!allowFile) throw new Error(`${path} is a file, not a directory`);
        yield file;
        return;
      }
      yield hostPaths[serverId]?.[path] ?? EMPTY_ARCHIVE;
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
        ? (hostFiles[serverId] ??= {})
        : (hostPaths[serverId] ??= {});
      into[path] = Buffer.concat(parts);
      return { ok: true, error: "" };
    },
    async stopStack(slug: string) {
      say("stop", slug);
      return { ok: true, error: "" };
    },
    async startStack(slug: string) {
      say("start", slug);
      if (startRefusesNoContainer) {
        startRefusesNoContainer = false;
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

/** The rows an import writes when it creates something - the ONLY thing that makes
 *  a service's data movable, and the reason a resource this run did not create can
 *  never be reached. */
async function seedRunItems(
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
      id: `dimi_seed_${i}_${r.sourceId}`,
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

/** A run holding everything the fixture imported. */
async function openRun(): Promise<string> {
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

/** Register the Deplo server that sits at the Dokploy address, which is the only
 *  thing that makes a copy possible - it is derived, never chosen. */
async function seedMigrationHostServer(): Promise<void> {
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

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetMigrationFetchForTest();
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await db.execute(TRUNCATE_PROJECT_GRAPH);
  await db.execute(TRUNCATE_IDENTITY);
  await db.execute("truncate table migration_runs cascade;");
  await db.execute("truncate table projects, environments cascade;");
  await db.execute("truncate table databases cascade;");
  await seedIdentity(db);
  await seedServer(db);
  __setMigrationFetchForTest(fakeSource());
  calls = [];
  agentCalls = [];
  unreachableAgents.clear();
  hostDiesMidCopy.clear();
  importRefusal = "";
  notFoundVolumes = new Set();
  sourceRunning = true;
  startRefusesNoContainer = false;
  stopRefusal = "";
  hostPaths = {
    srv_migration_host: { "/etc/dokploy/x": CONFIG_DIR },
  };
  hostFiles = {};
  extraWebMounts = [];
  agentCapabilities = ["host-path-copy.file"];
  // The Dokploy host holds both source volumes, with real content in them.
  volumes = {
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
        ReturnType<typeof import("../infra/agent-client").connectAgent>
      >,
  );

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
  // The bind mount the import carried across verbatim: same host path, same place
  // in the container. Its bytes are NOT in a volume, so they move by a different
  // RPC behind a different permission.
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
  // The imported stack: same compose, so the volume key is the same word on both
  // sides and only the project prefix differs.
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
});

function asOwner<T>(fn: () => Promise<T>): Promise<T> {
  return runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
}

/* ---- the plan -------------------------------------------------------- */

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
      // The bind mount is listed as what it is - a host PATH, moved by a different
      // RPC behind a different permission - rather than dropped in silence, which is how
      // an app used to arrive missing half its data with a report that said everything
      "/etc/dokploy/x->/etc/dokploy/x@/app/config.json",
    ],
  );
  assert.match(web.volumes[1].note!, /path on the host, not a volume/);
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
    calls.some((p) => p.endsWith(".stop")),
    false,
    "planning must never stop anything",
  );
  assert.ok(calls.includes("docker.getConfig"));
});

test("the plan says so when Deplo has no agent on the machine holding the data", async () => {
  const runId = await openRun();
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  // No Deplo server sits at the Dokploy address in this fixture, so every service
  // on it carries the warning - on the REVIEW screen, not at the cutover with the
  // old platform already stopped.
  assert.ok(
    plan.every((svc) =>
      svc.notes.some((n) => /no agent on the machine/.test(n)),
    ),
    JSON.stringify(plan.map((s) => s.notes)),
  );
});

test("the plan tells an enrolled-but-unreachable machine apart from a missing one", async () => {
  // Two different problems with two different fixes: "no agent here at all" means
  // install one, "the agent will not answer us" means the address or the firewall.
  await seedMigrationHostServer();
  unreachableAgents.add("srv_migration_host");
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

  unreachableAgents.delete("srv_migration_host");
  const good = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  assert.ok(good.every((svc) => svc.sourceReachable === true));
});

test("a resource this run did not create is not reachable at all", async () => {
  // The database is here and its name matches a Dokploy service exactly, which is
  // all the old name-matching needed to offer it up for a copy that WIPES it.
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
      // "already here, left as it is", which has to include its data.
      outcome: "skipped",
    },
  ]);
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  assert.deepEqual(plan, []);
});

/* ---- the copy -------------------------------------------------------- */

test("the copy reads the source host, and the bytes land in the target volume", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(res.moved, 2, "the named volume and the host directory");
  assert.equal(res.failed, 0);
  // Read from the machine that HOLDS it, written to the one that runs the app.
  assert.ok(
    agentCalls.includes("srv_migration_host:export:blink-web-abc_uploads"),
    agentCalls.join(" | "),
  );
  assert.ok(agentCalls.includes(`${SERVER_1}:import:deplo-blink-web-uploads`));
  assert.deepEqual(
    volumes[SERVER_1]["deplo-blink-web-uploads"],
    UPLOADS,
    "the destination must hold exactly what the source had",
  );
});

test("a source volume that is not on that host wipes nothing and is not a copy", async () => {
  await seedMigrationHostServer();
  // The volume is missing where the export runs: Docker answers with an empty
  // archive instead of failing, which is the whole bug this guards.
  delete volumes.srv_migration_host["blink-web-abc_uploads"];
  const before = volumes[SERVER_1]["deplo-blink-web-uploads"];
  const runId = await openRun();
  agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.deepEqual(
    volumes[SERVER_1]["deplo-blink-web-uploads"],
    before,
    "the destination must be untouched when the source has nothing",
  );
  assert.equal(
    agentCalls.some((c) => c.includes(":wipe:")),
    false,
    "a destination must never be emptied before the source has proven it has data",
  );
  const rows = await db.execute(
    `select outcome, message from migration_run_items where run_id = '${runId}' and source_kind = 'volume'`,
  );
  assert.equal(rows.rows[0].outcome, "skipped");
  assert.match(String(rows.rows[0].message), /holds nothing on Dokploy/);
});

test("a volume a never-started service has not created yet is not a loss", async () => {
  await seedMigrationHostServer();
  // The measured shape: created from a template, never deployed, so the volume it
  // declares does not exist on that host at all - and nothing of it is running.
  notFoundVolumes.add("blink-web-abc_uploads");
  sourceRunning = false;
  const runId = await openRun();

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.failed, 0, "nothing was lost, so nothing failed");

  const rows = await db.execute(
    `select outcome, message from migration_run_items where run_id = '${runId}' and source_kind = 'volume' and source_name = 'blink-web-abc_uploads'`,
  );
  assert.equal(rows.rows[0].outcome, "skipped");
  assert.match(
    String(rows.rows[0].message),
    /may simply never have been started/,
  );

  // And the app is NOT held back from its first deploy, which is the only way it
  // would ever get that volume.
  const app = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.equal(app.rows[0].data_copy_error, "");
});

test("a stop Dokploy refuses does not end the run when nothing is running", async () => {
  await seedMigrationHostServer();
  stopRefusal = "Command execution failed: spawn /bin/sh ENOENT";
  sourceRunning = false;

  const runId = await openRun();
  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.moved, 2, "the copy still ran");
  assert.equal(res.failed, 0);
  assert.match(res.notes.join(" "), /would not stop/);
});

test("a stop Dokploy refuses on a RUNNING service copies nothing", async () => {
  await seedMigrationHostServer();
  stopRefusal = "Command execution failed";
  const before = volumes[SERVER_1]["deplo-blink-web-uploads"];

  const runId = await openRun();
  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.moved, 0);
  assert.equal(res.failed, 1);
  assert.deepEqual(
    volumes[SERVER_1]["deplo-blink-web-uploads"],
    before,
    "a volume being written to must never be read out from under the writer",
  );
});

test("a copy that fails marks the app, and the marker holds the deploy", async () => {
  await seedMigrationHostServer();
  importRefusal = "no space left on device";
  const runId = await openRun();

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.ok(res.failed > 0, "the copy must be reported as failed");

  // On the ROW, not only in the report: the report is read by whoever is
  // watching the migration, this is read by whoever presses Deploy on Thursday.
  const rows = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.match(String(rows.rows[0].data_copy_error), /no space left on device/);

  // Close the run first: while it is open the app is the migration's and every
  // door refuses for THAT reason. This is about the reason that outlives it.
  // `finish`, not `stop`: stopping means undoing, and this app has to survive.
  await asOwner(() => finishMigration(runId));

  // And that is what refuses the deploy, from every door.
  await assert.rejects(
    () => asOwner(() => startDeployment("prj_web", { creator: "test" })),
    /did not come across/,
  );
  await assert.rejects(
    () => asOwner(() => startApp("prj_web")),
    /did not come across/,
  );
});

test("a copy that works clears a marker an earlier attempt left", async () => {
  await seedMigrationHostServer();
  importRefusal = "the stream was truncated";
  const runId = await openRun();
  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  // Running the migration again IS the fix, so the second pass has to lift the
  // block - otherwise the only way out would be accepting the loss.
  importRefusal = "";
  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.failed, 0);
  const rows = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.equal(rows.rows[0].data_copy_error, "");
});

test("accepting the loss unblocks the app, and says so in the trail", async () => {
  await seedMigrationHostServer();
  importRefusal = "the source host is gone";
  const runId = await openRun();
  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  // `finish`, not `stop`: stopping a run deletes what it created, and the whole
  // point here is the app that outlives the migration.
  await asOwner(() => finishMigration(runId));
  await asOwner(() => acceptDataCopyLoss({ kind: "app", id: "prj_web" }));

  const rows = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.equal(rows.rows[0].data_copy_error, "");
  const trail = await db.execute(
    "select message from activities where message like '%without the data%'",
  );
  assert.equal(trail.rows.length, 1);
});

// The other half of the same answer: Deplo asked ONE machine and there is no such
// volume on it. For a service that is RUNNING over there, "never started" is a
// claim about the source that Deplo never checked - and the app came up on empty
// storage with nothing holding it back.
test("a volume missing from a RUNNING service holds the deploy", async () => {
  await seedMigrationHostServer();
  notFoundVolumes.add("blink-web-abc_uploads");
  sourceRunning = true;
  startRefusesNoContainer = false;
  const runId = await openRun();

  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  const rows = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' and source_name = 'blink-web-abc_uploads'`,
  );
  assert.match(
    String(rows.rows[0].message),
    /is running, so its data is on a different machine/,
  );
  const app = await db.execute(
    "select data_copy_error from apps where id = 'prj_web'",
  );
  assert.match(String(app.rows[0].data_copy_error), /not on the machine/);
});

// Measured on a takeover after an external run had stopped the app: the config
// file the configuration channel had already carried was reported as a bind
// beside the compose file that nothing filled.
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

test("a stopped stack whose compose lives in a repo still names its volumes", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();

  // Nothing is running over there and Dokploy holds no inline compose, so the
  // only place the volume names exist is the file it would deploy. Without that
  // fallback the copy answered "there is nothing to copy" over live data, and the
  // only way back was restarting the stack on the source panel.
  const plan = await asOwner(() =>
    planMigrationDataMove({ ...CONNECT, runId }),
  );
  const stack = plan.find((s) => s.sourceName === "blink-stack");
  assert.ok(stack, JSON.stringify(plan.map((s) => s.sourceName)));
  assert.equal(stack.running, false);
  assert.deepEqual(
    stack.volumes.map((v) => `${v.sourceVolume}->${v.targetVolume}`),
    ["blinkstack-abc_store->deplo-blink-stack_store"],
  );

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "compose",
      sourceId: "dok-cmp-1",
    }),
  );
  assert.equal(res.moved, 1, res.notes.join(" | "));
  assert.equal(res.failed, 0);
});

test("nothing is stopped on the source when the volumes are not on that machine", async () => {
  await seedMigrationHostServer();
  // The measured shape: the panel names a machine, the data is on another one.
  // The old pre-flight only asked whether the agent ANSWERED, so the copy stopped
  // the service over there and then found nothing to read - both sides down.
  notFoundVolumes.add("blink-db-abc_data");
  sourceRunning = true;
  startRefusesNoContainer = false;
  const runId = await openRun();
  calls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
    }),
  );

  assert.equal(res.failed, 1, "a service whose data did not move is a failure");
  assert.equal(res.moved, 0);
  assert.equal(
    calls.some((c) => c.endsWith(".stop")),
    false,
    "the source must still be up: nothing could have been copied off it",
  );
  assert.equal(
    agentCalls.some((c) => c.includes(":wipe:")),
    false,
    "and the destination must still hold whatever it had",
  );
  assert.match(res.notes.join(" "), /none of the volumes it names/);
  // The refusal names the product, not the placeholder - this one reaches a dialog.
  assert.equal(res.notes.join(" ").includes("{panel}"), false);

  const rows = await db.execute(
    `select outcome from migration_run_items where run_id = '${runId}' and source_id = 'dok-pg-1' order by seq desc`,
  );
  assert.equal(rows.rows[0].outcome, "failed");
  const row = await db.execute(
    "select status, data_copy_error from databases where id = 'db_blink'",
  );
  assert.equal(row.rows[0].status, "running", "it was never stopped");
  assert.match(String(row.rows[0].data_copy_error), /never copied/);
});

test("a volume that did not come across is counted failed, not skipped", async () => {
  await seedMigrationHostServer();
  // The bind mount is copyable, so the service is not refused outright - but the
  // volume that is not there is data nobody moved, and a run that ends
  // `failed: 0` over it reads as a clean migration.
  notFoundVolumes.add("blink-web-abc_uploads");
  sourceRunning = true;
  startRefusesNoContainer = false;
  const runId = await openRun();

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.failed, 1);

  const rows = await db.execute(
    `select outcome from migration_run_items where run_id = '${runId}' and source_name = 'blink-web-abc_uploads'`,
  );
  assert.equal(rows.rows[0].outcome, "failed");
  const run = await db.execute(
    `select failed from migration_runs where id = '${runId}'`,
  );
  assert.equal(Number(run.rows[0].failed), 1, "and the summary says so");
});

test("a database with nothing to copy is left RUNNING, not stopped", async () => {
  await seedMigrationHostServer();
  // Never started on Dokploy, so the data volume it declares is not there.
  notFoundVolumes.add("blink-db-abc_data");
  sourceRunning = false;
  const runId = await openRun();
  agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
    }),
  );
  assert.equal(res.moved, 0);
  assert.equal(res.failed, 0);

  // The copy stops the destination before it writes. Nothing to write is not a
  // reason to leave somebody's database down.
  assert.ok(agentCalls.includes(`${SERVER_1}:stop:db-blink-db`));
  assert.ok(
    agentCalls.includes(`${SERVER_1}:start:db-blink-db`),
    agentCalls.join(" | "),
  );
  const rows = await db.execute(
    "select status, data_copy_error from databases where id = 'db_blink'",
  );
  assert.equal(rows.rows[0].status, "running");
  assert.equal(rows.rows[0].data_copy_error, "");

  const items = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' order by seq`,
  );
  const messages = items.rows.map((r) => String(r.message ?? ""));
  assert.ok(
    messages.some((m) => /Nothing was copied into it/.test(m)),
    messages.join(" | "),
  );
  assert.equal(
    messages.some((m) => /up on the copied data/.test(m)),
    false,
    "nothing was copied, so nothing may claim it was",
  );
});

test("a database whose container never came up is set up on the copied volume", async () => {
  // Its provisioning failed before the copy (the image would not pull), so the
  // start finds nothing. The data is in the volume: create the container on it
  // instead of reporting "no container to start" as the end of the story.
  await seedMigrationHostServer();
  const runId = await openRun();
  agentCalls = [];
  startRefusesNoContainer = true;

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
    }),
  );

  const said = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' and source_id = 'dok-pg-1' order by seq`,
  );
  assert.equal(
    res.failed,
    0,
    said.rows.map((r) => r.message).join(" | ") + " " + agentCalls.join(" | "),
  );
  assert.ok(
    agentCalls.includes(`${SERVER_1}:reroute:db-blink-db`),
    agentCalls.join(" | "),
  );
  const items = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' and message like '%no container%'`,
  );
  assert.equal(
    items.rows.length,
    0,
    "the missing container is fixed, not reported",
  );
});

test("a copied database is started again and checked, and the report says what landed", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
    }),
  );

  assert.equal(res.moved, 1);
  assert.equal(res.failed, 0);
  assert.deepEqual(
    volumes[SERVER_1]["deplo-db-blink-db_db-blink-db-data"],
    DB_DATA,
  );
  // Stopped for the copy, started again afterwards: a database left down would
  // read as a broken migration.
  assert.ok(agentCalls.includes(`${SERVER_1}:stop:db-blink-db`));
  assert.ok(agentCalls.includes(`${SERVER_1}:start:db-blink-db`));

  const items = await db.execute(
    `select outcome, message from migration_run_items where run_id = '${runId}' order by seq`,
  );
  const messages = items.rows.map((r) => String(r.message ?? ""));
  // The size is IN the report. A copy that says only "Copied" is exactly what a
  // copy of nothing said for as long as this was broken.
  assert.ok(
    messages.some((m) =>
      /Copied \d[\d.]* [kMG]?B \(compressed\) into deplo-db-blink-db_db-blink-db-data/.test(
        m,
      ),
    ),
    messages.join(" | "),
  );
  assert.ok(
    messages.some((m) => /is up on the copied data/.test(m)),
    messages.join(" | "),
  );
  const running = await db.execute(
    "select status from databases where id = 'db_blink'",
  );
  assert.equal(running.rows[0].status, "running");
});

test("a database whose data did not arrive refuses to be restarted", async () => {
  await seedMigrationHostServer();
  importRefusal = "the stream was truncated";
  const runId = await openRun();

  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "postgres",
      sourceId: "dok-pg-1",
    }),
  );

  const rows = await db.execute(
    "select data_copy_error from databases where id = 'db_blink'",
  );
  assert.match(String(rows.rows[0].data_copy_error), /truncated/);
  // The dangerous half: an engine handed an empty data directory does not fail,
  // it initialises a new database over the old one's place.
  await assert.rejects(
    () => asOwner(() => restartDatabase("db_blink")),
    /did not come across/,
  );
  await assert.rejects(
    () => asOwner(() => redeployDatabase("db_blink")),
    /did not come across/,
  );
});

test("a bind mount's host directory is copied too, and says it is a directory", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  // The named volume AND the host directory: an app arrives whole or the report
  // names what is missing.
  assert.equal(res.moved, 2, JSON.stringify(res));
  assert.ok(
    agentCalls.includes("srv_migration_host:export-path:/etc/dokploy/x"),
    agentCalls.join(" | "),
  );
  assert.deepEqual(hostPaths[SERVER_1]["/etc/dokploy/x"], CONFIG_DIR);
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
  // The panel handed over the file's CONTENT with the configuration, so it lands
  // as a project file rather than a bind - and nothing of it is missing.
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
  // `- /srv/site/nginx.conf:/etc/nginx/nginx.conf` - ordinary compose, and the
  // export refuses a file. Copying the directory it sits in would carry every
  // sibling of it across; the file is what the stack mounts.
  extraWebMounts.push({
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
  hostFiles = { srv_migration_host: { "/srv/site/nginx.conf": CONFIG_DIR } };
  await seedMigrationHostServer();
  const runId = await openRun();
  agentCalls = [];

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
  assert.deepEqual(hostFiles[SERVER_1]?.["/srv/site/nginx.conf"], CONFIG_DIR);
  // Never the directory around it: that is somebody else's data.
  assert.equal(
    agentCalls.some((c) => c.endsWith(":/srv/site")),
    false,
    agentCalls.join(" | "),
  );
});

test("a file the destination agent cannot take is refused, never guessed", async () => {
  // An agent that does not know the flag would create a DIRECTORY of that name and
  // the stack would come back up on it - broken, and reported as copied.
  agentCapabilities = [];
  extraWebMounts.push({
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
  hostFiles = { srv_migration_host: { "/srv/site/nginx.conf": CONFIG_DIR } };
  await seedMigrationHostServer();
  const runId = await openRun();
  agentCalls = [];

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
  // Nothing of it reached the target: no directory of that name, no bytes.
  assert.equal(hostPaths[SERVER_1]?.["/srv/site/nginx.conf"], undefined);
  assert.equal(hostFiles[SERVER_1]?.["/srv/site/nginx.conf"], undefined);
});

test("a system file a stack binds is not data, and is never even read", async () => {
  // `- /etc/localtime:/etc/localtime:ro` is on half the compose files in the
  // world. It holds no data of the app, the export refuses it, and the refusal
  // used to reach the report as a lost volume AND hold the deploy.
  for (const p of ["/etc/localtime", "/etc/timezone", "/etc/resolv.conf"])
    extraWebMounts.push({ Type: "bind", Source: p, Destination: p });
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
  agentCalls = [];

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
    agentCalls.some((c) => c.includes("/etc/localtime")),
    false,
    agentCalls.join(" | "),
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

test("a host directory already on this machine is not copied over itself", async () => {
  // Same machine on both sides: the directory the app reads IS the one the old
  // platform wrote, so a wipe-then-restore of it is all risk and no movement.
  await db.execute(
    `update servers set host = 'dokploy.acme.test', ip = 'dokploy.acme.test' where id = '${SERVER_1}'`,
  );
  const runId = await openRun();
  volumes[SERVER_1]["blink-web-abc_uploads"] = UPLOADS;
  agentCalls = [];

  await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );

  assert.equal(
    agentCalls.some((c) => c.includes("wipe-path")),
    false,
    "a directory must never be emptied to restore itself",
  );
  const items = await db.execute(
    `select message from migration_run_items where run_id = '${runId}' and message like '%already on this machine%'`,
  );
  assert.equal(items.rows.length, 1);
});

test("the plan does not call a bind already in place a clash", async () => {
  // A takeover: same machine, same path. Another app mounting that directory
  // is not a wipe waiting to happen, because nothing is copied at all.
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
  // Both apps mount /etc/dokploy/x on the same source machine. That is one
  // directory over there, so it is one directory here: the first copy fills it,
  // the second keeps it - neither is a stranger's data about to be wiped.
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

  // The same directory again, for the other service: already here.
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

/* ---- the refusals ---------------------------------------------------- */

test("nothing is stopped until Deplo knows which server holds the data", async () => {
  // No Deplo server sits at the Dokploy address, so there is no host to read from.
  const runId = await openRun();
  calls = [];
  agentCalls = [];
  await assert.rejects(
    () =>
      asOwner(() =>
        moveMigrationServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-web",
        }),
      ),
    /no agent on the machine/,
  );
  assert.equal(
    calls.some((p) => p.endsWith(".stop")),
    false,
    "the source must still be running after a refusal",
  );
  assert.deepEqual(agentCalls, [], "and nothing of ours may be touched either");
});

test("a source that is enrolled but will not answer US stops nothing and copies nothing", async () => {
  // The row says `online`, because that is what the CALL-HOME sets and the call-home
  // is the agent dialing OUT.
  await seedMigrationHostServer();
  unreachableAgents.add("srv_migration_host");
  const runId = await openRun();
  calls = [];
  agentCalls = [];

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.moved, 0);
  assert.equal(res.failed, 1);
  assert.equal(
    calls.some((p) => p.endsWith(".stop")),
    false,
    "the source must still be running on Dokploy",
  );
  assert.deepEqual(
    agentCalls,
    ["srv_migration_host:hello:"],
    "one question, and it gave up on the answer",
  );

  const items = await db.select().from(itemsTable);
  const failure = items.find((i) => i.outcome === "failed");
  assert.match(failure?.message ?? "", /cannot reach the agent/);
});

test("a source that dies MID-COPY says so, so the caller can stop the whole run", async () => {
  // The pre-flight cannot see this one: the machine answered, the service was stopped
  // on Dokploy, and the connection died with bytes in flight.
  await seedMigrationHostServer();
  hostDiesMidCopy.add("srv_migration_host");
  const runId = await openRun();

  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.sourceGone, true, "the MACHINE went, not just this volume");
  assert.ok(res.failed > 0);
});

test("an ordinary failed copy does NOT claim the machine went away", async () => {
  // The other half of the flag, and the half that keeps it meaningful: a volume that
  // is simply not on that host is one report line and the run carries on.
  await seedMigrationHostServer();
  delete volumes.srv_migration_host["blink-web-abc_uploads"];
  const runId = await openRun();
  const res = await asOwner(() =>
    moveMigrationServiceData({
      ...CONNECT,
      runId,
      sourceKind: "application",
      sourceId: "dok-app-web",
    }),
  );
  assert.equal(res.sourceGone, false);
});

test("a service this run did not import cannot be moved into anything", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  await assert.rejects(
    () =>
      asOwner(() =>
        moveMigrationServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-ghost",
        }),
      ),
    /did not create anything/,
  );
});

test("a service Dokploy no longer has is refused before anything else", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  await assert.rejects(
    () =>
      asOwner(() =>
        moveMigrationServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-vanished",
        }),
      ),
    /no longer on the Dokploy instance/,
  );
});

test("a run from another team is not a place to write a report", async () => {
  await seedMigrationHostServer();
  const runId = await openRun();
  await assert.rejects(
    () =>
      runWithIdentity({ userId: USER_1, teamId: TEAM_B }, () =>
        moveMigrationServiceData({
          ...CONNECT,
          runId,
          sourceKind: "application",
          sourceId: "dok-app-web",
        }),
      ),
    /scoped to a team the user no longer belongs to|does not belong to this team/,
  );
});

test("the data phase never names a product (ADR-0026)", async () => {
  // Thirteen hardcoded "Dokploy"s used to reach a Coolify report - "ghost is
  // still running on Dokploy (Coolify request failed 404)" in one sentence.
  // `appendRunItem` resolves `{panel}` from the run's own platform, so a mapper
  // and this file both write the placeholder and neither knows which panel it is.
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("./migration-data.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /Dokploy|Coolify/);
});

test("a bind another team's app also mounts is not wiped", async () => {
  await seedMigrationHostServer();
  // The same host directory, claimed by an app in ANOTHER team on the machine
  // that receives the copy. Two migrations of two apps that both mount /opt/data
  // is all it takes, and the copy wipes before it writes.
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

  agentCalls = [];
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
    hostPaths[SERVER_1],
    undefined,
    "nothing on the host was written",
  );
  assert.ok(
    !agentCalls.some((c) => c.startsWith(`${SERVER_1}:wipe-path`)),
    agentCalls.join(" | "),
  );
  const items = await db.execute(
    "select outcome, message from migration_run_items where message like '%another team''s app%'",
  );
  assert.ok(items.rows.length >= 1, "the report has to name the other app");
  assert.ok(items.rows.every((r) => r.outcome === "manual"));
});
