import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

process.env.DEPLO_PUBLIC_URL = "https://old.example";

import { makeTestDb, type TestDb } from "../../db/test-harness";
import { __setTestDb, __resetTestDb } from "../../db/client";
import { activities } from "../../db/schema/control-plane/activity";
import { appVolumes, apps } from "../../db/schema/control-plane/apps";
import { databases } from "../../db/schema/control-plane/databases";
import {
  deploMovePauses,
  deploMoves,
} from "../../db/schema/control-plane/deplo-move";
import { runWithIdentity } from "../../auth/request-context";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import type { AgentConnection } from "../../infra/agent-client/connection";
import { AgentUnreachableError } from "../../infra/agent-client/errors";
import { instanceFingerprint } from "../../migration/deplo/instance";
import { schemaTag } from "../../deplo-move/schema-tag";
import {
  MOVE_FILENAME_HEADER,
  MOVE_PEER_HEADER,
  MOVE_PEER_URL_HEADER,
  type MoveStep,
  type WorkloadRef,
} from "../../deplo-move/protocol";
import { seedIdentity, TEAM_A, TEAM_B, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import {
  seedApp,
  seedDeployment,
  TRUNCATE_PROJECT_GRAPH,
} from "../app-graph-test-helpers";
import { startDeployment } from "../../deploy/build/deploy-start";
import { rebuildApp, startApp, stopApp } from "../apps/lifecycle";
import {
  rebuildDatabase,
  redeployDatabase,
  restartDatabase,
  setDatabaseRunning,
} from "../databases/lifecycle";
import { redeploy, reloadApp } from "../deployments/stack-actions";
import { restartServerWorkloads } from "../server-maintenance";
import { instanceFrozen, invalidateFrozen } from "./freeze";
import { assertNotPausedForMove } from "./source-guard";
import { rerouteApp } from "../../deploy/build/reroute";
import { rerouteDatabase } from "../databases/stack";
import { rotateDatabasePassword } from "../databases/rotate-password";
import { setDatabaseMounts } from "../databases/mounts";
import { cancelMoveCode, createMoveCode, sourceMoveStatus } from "./source";
import { __setPauseTimingForTest, resumeLapsedPauses } from "./source-pauses";
import {
  __setDumperForTest,
  moveCancel,
  moveDump,
  moveFiles,
  moveFinish,
  moveHello,
  moveHostPath,
  moveImage,
  movePause,
  moveResume,
  moveUpload,
  moveVolume,
  moveWorkload,
  type MoveCaller,
} from "./source-api";
import { POST } from "@/app/api/deplo-move/[step]/route";

let db: TestDb;
let pg: PGlite;
let dataDir: string;

const PEER = "peer-instance-1";
const NEW = "https://new.example";
const SRV = "srv_move";
const MEMBER = "user_member";
const PAST = "2000-01-01T00:00:00.000Z";
const T0 = "2026-01-01T00:00:00.000Z";

const WEB: WorkloadRef = { kind: "app", id: "prj_web" };
const MAIN: WorkloadRef = { kind: "database", id: "dbs_main" };
const MAIN_VOLUME = "deplo-db-main_db-main-data";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  dataDir = mkdtempSync(join(tmpdir(), "deplo-move-source-"));
});

after(async () => {
  __setAgentConnectorForTest();
  __setDumperForTest();
  __setPauseTimingForTest();
  invalidateFrozen();
  __resetTestDb();
  await pg.close();
  rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await pg.exec(`${TRUNCATE_PROJECT_GRAPH}
    truncate table deplo_moves, deplo_move_pauses, databases, activities,
      users, teams restart identity cascade;`);
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: MEMBER, teamId: TEAM_B, role: "member", isInstanceAdmin: false },
    ],
  });
  await seedServerRow(db, {
    id: SRV,
    name: "web-1",
    ip: "192.0.2.10",
    host: "192.0.2.10",
    agent: {
      port: 9443,
      certFingerprint: "fp-old",
      certPem: "-----BEGIN CERTIFICATE-----",
      version: "1.0.0",
    },
  });
  await seedServerRow(db, { id: "srv_never", name: "never-enrolled" });
  __setDumperForTest(async function* () {
    yield '{"kind":"begin"}';
    yield '{"kind":"end"}';
  });
  __setPauseTimingForTest();
  invalidateFrozen();
  process.env.DEPLO_DATA_DIR = dataDir;
  fakeAgent();
});

interface Fake {
  calls: string[];
  running: Map<string, boolean>;
  stacks: Map<string, string>;
  present: Set<string>;
  capabilities: string[];
  failStart: boolean;
  exportError: Error | null;
  emptyExport: boolean;
  chunkDelayMs: number;
  // Runs inside the agent call, before it returns: what else happened while it worked.
  onStop: (() => Promise<void>) | null;
  onStart: (() => Promise<void>) | null;
}

let agent: Fake;

function fakeAgent(over: Partial<Fake> = {}): Fake {
  const f: Fake = {
    calls: [],
    running: new Map(),
    stacks: new Map(),
    present: new Set(["deplo-web-data", MAIN_VOLUME]),
    capabilities: ["volume-usage"],
    failStart: false,
    exportError: null,
    emptyExport: false,
    chunkDelayMs: 0,
    onStop: null,
    onStart: null,
    ...over,
  };
  agent = f;
  const exported = (label: string) =>
    (async function* () {
      f.calls.push(label);
      if (f.exportError) throw f.exportError;
      if (f.emptyExport) return;
      yield Buffer.from(`${label}|`);
      if (f.chunkDelayMs)
        await new Promise((r) => setTimeout(r, f.chunkDelayMs));
      yield Buffer.from("end");
    })();
  const conn = {
    hello: async () => ({
      capabilities: f.capabilities,
      agentVersion: "1.2.3",
    }),
    listInstances: async (_id: string, slug: string) => [
      { name: slug, running: f.running.get(slug) ?? false },
    ],
    readStack: async (slug: string) =>
      f.stacks.has(slug)
        ? { exists: true, yaml: f.stacks.get(slug)! }
        : { exists: false, yaml: "" },
    volumeUsage: async (names: string[]) =>
      new Map(names.filter((n) => f.present.has(n)).map((n) => [n, 1])),
    stopStack: async (slug: string) => {
      f.calls.push(`stop:${slug}`);
      const hook = f.onStop;
      f.onStop = null;
      await hook?.();
      f.running.set(slug, false);
      return { ok: true, error: "" };
    },
    startStack: async (slug: string) => {
      f.calls.push(`start:${slug}`);
      const hook = f.onStart;
      f.onStart = null;
      await hook?.();
      if (f.failStart) return { ok: false, error: "the daemon is busy" };
      f.running.set(slug, true);
      return { ok: true, error: "" };
    },
    exportVolume: (name: string) => exported(`volume:${name}`),
    exportHostPath: (path: string, allowFile = false) =>
      exported(`hostpath:${path}:${allowFile}`),
    exportFiles: (slug: string) => exported(`files:${slug}`),
    exportImage: (ref: string, removeAfter: boolean) =>
      exported(`image:${ref}:${removeAfter}`),
    close: () => {},
  };
  __setAgentConnectorForTest(async () => conn as unknown as AgentConnection);
  return f;
}

function unreachable(): void {
  __setAgentConnectorForTest(async () => {
    throw new AgentUnreachableError("connect ECONNREFUSED");
  });
}

const asAdmin = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

async function mint(): Promise<MoveCaller> {
  const { code } = await asAdmin(() => createMoveCode());
  return { code, peerInstance: PEER, peerUrl: `${NEW}/` };
}

async function drain<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

async function copying(): Promise<MoveCaller> {
  const caller = await mint();
  await moveHello(caller);
  await drain(await moveDump(caller));
  return caller;
}

async function text(open: Promise<{ chunks: AsyncIterable<Buffer> }>) {
  return Buffer.concat(await drain((await open).chunks)).toString();
}

async function messages(): Promise<{ teamId: string; message: string }[]> {
  return db
    .select({ teamId: activities.teamId, message: activities.message })
    .from(activities);
}

async function inEveryTeam(message: string): Promise<void> {
  const teams = (await messages())
    .filter((m) => m.message === message)
    .map((m) => m.teamId)
    .sort();
  assert.deepEqual(teams, [TEAM_A, TEAM_B], `"${message}" once in every team`);
}

async function pauses() {
  return db.select().from(deploMovePauses);
}

async function seedWeb(): Promise<void> {
  await seedApp(db, { id: WEB.id, slug: "web", serverId: SRV });
  await db.insert(appVolumes).values([
    {
      appId: WEB.id,
      position: 0,
      volumeId: "vol_data",
      type: "named",
      name: "data",
      mountPath: "/var/lib/data",
      readOnly: false,
    },
    {
      appId: WEB.id,
      position: 1,
      volumeId: "vol_cache",
      type: "named",
      name: "cache",
      mountPath: "/cache",
      readOnly: false,
    },
    {
      appId: WEB.id,
      position: 2,
      volumeId: "vol_uploads",
      type: "host",
      name: "uploads",
      hostPath: "/srv/web-uploads/",
      mountPath: "/uploads",
      readOnly: false,
    },
    {
      appId: WEB.id,
      position: 3,
      volumeId: "vol_sock",
      type: "host",
      name: "docker",
      hostPath: "/var/run/docker.sock",
      mountPath: "/var/run/docker.sock",
      readOnly: false,
    },
  ]);
  await seedDeployment(db, {
    id: "dep_build",
    appId: WEB.id,
    serverId: SRV,
    imageRef: "deplo/web:1",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  await seedDeployment(db, {
    id: "dep_rollback",
    appId: WEB.id,
    serverId: SRV,
    imageRef: "deplo/web:1",
    rollbackOf: "dep_build",
    createdAt: "2026-01-02T00:00:00.000Z",
  });
  await seedDeployment(db, {
    id: "dep_error",
    appId: WEB.id,
    serverId: SRV,
    status: "error",
    imageRef: "deplo/web:2",
    createdAt: "2026-01-03T00:00:00.000Z",
  });
}

async function seedMain(): Promise<void> {
  await db.insert(databases).values({
    id: MAIN.id,
    teamId: TEAM_A,
    name: "main",
    type: "postgres",
    version: "16",
    username: "app",
    dbName: "app",
    status: "active",
    serverId: SRV,
    host: "db-main",
    port: 5432,
    connectionStringEnc: "x",
    exposedPublicly: false,
    sizeMb: 0,
    createdAt: T0,
  });
}

async function route(
  step: MoveStep | string,
  init: { code?: string; peer?: string; body?: unknown; raw?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = { [MOVE_PEER_URL_HEADER]: NEW };
  if (init.code) headers.authorization = `Bearer ${init.code}`;
  if (init.peer !== "") headers[MOVE_PEER_HEADER] = init.peer ?? PEER;
  return POST(
    new Request(`https://old.example/api/deplo-move/${step}`, {
      method: "POST",
      headers,
      body: init.raw ?? JSON.stringify(init.body ?? {}),
    }),
    { params: Promise.resolve({ step }) },
  );
}

const errorOf = async (res: Response) =>
  (await res.json()) as { error: string; code?: number };

test("only an instance admin mints a move code", async () => {
  await assert.rejects(
    runWithIdentity({ userId: MEMBER, teamId: TEAM_B }, () => createMoveCode()),
    /instance admin/i,
  );
});

test("a fresh code is armed, hashed, and written to every team", async () => {
  const { code, expiresAt } = await asAdmin(() => createMoveCode());
  assert.match(code, /^dmove_[A-Za-z0-9_-]{32}$/);
  assert.ok(Date.parse(expiresAt) > Date.now() + 59 * 60_000);
  const [row] = await db.select().from(deploMoves);
  assert.equal(row.state, "armed");
  assert.notEqual(row.codeHash, code, "never stored in the clear");
  await inEveryTeam("Created a code to move this Deplo");
  const status = await asAdmin(() => sourceMoveStatus());
  assert.equal(status?.state, "armed");
  assert.equal(status?.expiresAt, expiresAt);
});

test("a new code replaces an unused one", async () => {
  const first = await mint();
  await moveHello(first);
  const second = await mint();
  assert.equal((await db.select().from(deploMoves)).length, 1);
  await assert.rejects(moveHello(first), { status: 401 });
  assert.equal((await moveHello(second)).state, "bound");
});

test("an armed code expires; a bound one does not", async () => {
  const caller = await mint();
  await db.update(deploMoves).set({ expiresAt: PAST });
  await assert.rejects(moveHello(caller), {
    status: 401,
    message: /expired/,
  });
  assert.equal(await asAdmin(() => sourceMoveStatus()), null);

  const fresh = await mint();
  await moveHello(fresh);
  await db.update(deploMoves).set({ expiresAt: PAST });
  assert.equal((await moveHello(fresh)).state, "bound");
});

test("the first hello binds the code to that Deplo and describes this one", async () => {
  await seedApp(db, { id: "prj_web", slug: "web", serverId: SRV });
  await seedMain();
  const caller = await mint();
  const hello = await moveHello(caller);
  assert.equal(hello.protocol, 2);
  assert.equal(hello.schema, schemaTag());
  assert.equal(hello.instance, instanceFingerprint());
  assert.equal(hello.panelUrl, "https://old.example");
  assert.equal(hello.state, "bound");
  assert.deepEqual(hello.counts, {
    teams: 2,
    users: 2,
    apps: 1,
    databases: 1,
    servers: 2,
  });
  const web = hello.servers.find((s) => s.id === SRV)!;
  assert.deepEqual(web, {
    id: SRV,
    name: "web-1",
    address: "192.0.2.10",
    port: 9443,
    role: "workloads",
    isPanelHost: false,
    enrolled: true,
    reachable: true,
    agentVersion: "1.2.3",
    apps: 1,
    databases: 1,
    databaseHosts: [{ id: MAIN.id, name: "main", host: "db-main" }],
  });
  const never = hello.servers.find((s) => s.id === "srv_never")!;
  assert.equal(never.enrolled, false);
  assert.equal(never.reachable, false);
  assert.deepEqual(never.databaseHosts, []);

  const [row] = await db.select().from(deploMoves);
  assert.equal(row.state, "bound");
  assert.equal(row.peerInstance, PEER);
  assert.equal(row.peerUrl, NEW, "stored as an origin");
});

test("a bound code refuses any other Deplo, and this one", async () => {
  const caller = await mint();
  await moveHello(caller);
  await assert.rejects(moveHello({ ...caller, peerInstance: "someone-else" }), {
    status: 403,
    message: /another Deplo/,
  });
  const self = await mint();
  await assert.rejects(
    moveHello({ ...self, peerInstance: instanceFingerprint() }),
    { status: 403 },
  );
});

test("the first dump starts the copy, once, and this Deplo is never paused", async () => {
  await seedWeb();
  const caller = await mint();
  await moveHello(caller);
  await assert.rejects(moveWorkload(caller, WEB), {
    status: 409,
    message: /has not started/,
  });
  assert.deepEqual(await drain(await moveDump(caller)), [
    '{"kind":"begin"}',
    '{"kind":"end"}',
  ]);
  await drain(await moveDump(caller));
  assert.equal((await db.select().from(deploMoves))[0].state, "copying");
  await inEveryTeam(`Copying this Deplo to ${NEW}`);
  assert.equal(await instanceFrozen(), null);
  assert.equal((await asAdmin(() => sourceMoveStatus()))?.state, "copying");
  await assert.rejects(
    asAdmin(() => createMoveCode()),
    /Cancel it first/,
  );
});

test("an app's workload is read live: running, present volumes, host paths, its image", async () => {
  await seedWeb();
  const caller = await copying();
  agent.running.set("web", true);
  assert.deepEqual(await moveWorkload(caller, WEB), {
    kind: "app",
    id: WEB.id,
    name: WEB.id,
    slug: "web",
    serverId: SRV,
    running: true,
    volumes: ["deplo-web-data"],
    files: false,
    hostPaths: [{ path: "/srv/web-uploads", allowFile: true }],
    skippedHostPaths: ["/var/run/docker.sock"],
    image: { ref: "deplo/web:1", deploymentId: "dep_build" },
    upload: null,
  });

  agent.capabilities = [];
  const old = await moveWorkload(caller, WEB);
  assert.deepEqual(
    old.volumes,
    ["deplo-web-data", "deplo-web-cache"],
    "an agent that cannot say which exist lists them all",
  );
});

test("a compose app's volumes come from its live stack, and its files come too", async () => {
  const compose = `services:
  api:
    image: api
    volumes:
      - pgdata:/var/lib/postgresql/data
      - /srv/data:/data
      - ./conf:/etc/conf
volumes:
  pgdata: {}
  shared:
    external: true
`;
  await seedApp(db, {
    id: "prj_stack",
    slug: "stack",
    serverId: SRV,
    source: "compose",
    repo: null,
    compose,
  });
  const caller = await copying();
  agent.stacks.set("stack", compose);
  agent.present.add("deplo-stack_pgdata");
  const info = await moveWorkload(caller, { kind: "app", id: "prj_stack" });
  assert.deepEqual(info.volumes, ["deplo-stack_pgdata"]);
  assert.equal(info.files, true);
  assert.deepEqual(info.hostPaths, [{ path: "/srv/data", allowFile: true }]);
  assert.deepEqual(info.skippedHostPaths, []);
  assert.equal(info.image, null, "a compose stack builds no image of its own");
});

test("a database's workload is its data volume", async () => {
  await seedMain();
  const caller = await copying();
  assert.deepEqual(await moveWorkload(caller, MAIN), {
    kind: "database",
    id: MAIN.id,
    name: "main",
    slug: "db-main",
    serverId: SRV,
    running: false,
    volumes: [MAIN_VOLUME],
    files: false,
    hostPaths: [],
    skippedHostPaths: [],
    image: null,
    upload: null,
  });
  await assert.rejects(moveWorkload(caller, { kind: "app", id: "nope" }), {
    status: 404,
  });
  await assert.rejects(
    moveWorkload(caller, { kind: "server" as never, id: SRV }),
    { status: 400 },
  );
  unreachable();
  await assert.rejects(moveWorkload(caller, MAIN), {
    status: 424,
    message: /^main: /,
  });
});

test("pause stops a running workload under a lease; a second pause only renews it", async () => {
  await seedWeb();
  await seedMain();
  const caller = await copying();
  agent.running.set("web", true);
  const first = await movePause(caller, WEB);
  assert.equal(first.wasRunning, true);
  assert.ok(Date.parse(first.leaseUntil) > Date.now() + 60_000);
  assert.deepEqual(agent.calls, ["stop:web"]);

  await db.update(deploMovePauses).set({ leaseUntil: PAST });
  const again = await movePause(caller, WEB);
  assert.equal(again.wasRunning, true, "remembered, not re-read");
  assert.ok(Date.parse(again.leaseUntil) > Date.now());
  assert.deepEqual(agent.calls, ["stop:web"], "nothing stopped twice");

  assert.equal((await movePause(caller, MAIN)).wasRunning, false);
  assert.deepEqual(agent.calls, ["stop:web"], "a stopped database is left be");
  assert.equal(await instanceFrozen(), null);

  assert.deepEqual(await moveResume(caller, MAIN), { resumed: true });
  assert.deepEqual(await moveResume(caller, WEB), { resumed: true });
  assert.deepEqual(agent.calls, ["stop:web", "start:web"]);
  assert.deepEqual(await moveResume(caller, WEB), { resumed: false });
  assert.deepEqual(agent.calls, ["stop:web", "start:web"]);
  assert.equal((await pauses()).length, 0);
});

test("a lapsed lease starts the workload again, and only once", async () => {
  await seedWeb();
  const caller = await copying();
  agent.running.set("web", true);
  await movePause(caller, WEB);
  await resumeLapsedPauses();
  assert.deepEqual(agent.calls, ["stop:web"], "a live lease is kept");

  await db.update(deploMovePauses).set({ leaseUntil: PAST });
  await resumeLapsedPauses();
  await resumeLapsedPauses();
  assert.deepEqual(agent.calls, ["stop:web", "start:web"]);
  assert.equal((await pauses()).length, 0);
  assert.deepEqual(await moveResume(caller, WEB), { resumed: false });
  assert.deepEqual(agent.calls, ["stop:web", "start:web"]);
});

test("a resumed workload is never started again by the sweep", async () => {
  await seedWeb();
  const caller = await copying();
  agent.running.set("web", true);
  await movePause(caller, WEB);
  await moveResume(caller, WEB);
  await resumeLapsedPauses();
  assert.deepEqual(agent.calls, ["stop:web", "start:web"]);
});

test("a workload that will not start stays for the next sweep", async () => {
  await seedWeb();
  const caller = await copying();
  agent.running.set("web", true);
  await movePause(caller, WEB);
  agent.failStart = true;
  await assert.rejects(moveResume(caller, WEB), {
    status: 409,
    message: /daemon is busy/,
  });
  assert.equal((await pauses()).length, 1, "back in the table, lapsed");
  await resumeLapsedPauses();
  assert.equal((await pauses()).length, 1);
  agent.failStart = false;
  await resumeLapsedPauses();
  assert.equal((await pauses()).length, 0);
  assert.equal(agent.running.get("web"), true);
});

test("every data step renews the lease of its workload", async () => {
  await seedWeb();
  const caller = await copying();
  agent.running.set("web", true);
  await movePause(caller, WEB);
  await db.update(deploMovePauses).set({ leaseUntil: PAST });
  assert.equal(
    await text(moveVolume(caller, { ...WEB, volume: "deplo-web-data" })),
    "volume:deplo-web-data|end",
  );
  const [row] = await pauses();
  assert.ok(Date.parse(row.leaseUntil) > Date.now() + 60_000);
});

test("the lease keeps renewing while a long stream runs", async () => {
  await seedWeb();
  const caller = await copying();
  agent.running.set("web", true);
  agent.chunkDelayMs = 300;
  __setPauseTimingForTest({ renewMs: 20 });
  await movePause(caller, WEB);
  const stream = await moveVolume(caller, { ...WEB, volume: "deplo-web-data" });
  const it = stream.chunks[Symbol.asyncIterator]();
  await it.next();
  await db.update(deploMovePauses).set({ leaseUntil: PAST });
  const pending = it.next();
  await new Promise((r) => setTimeout(r, 120));
  const [row] = await pauses();
  assert.ok(
    Date.parse(row.leaseUntil) > Date.now(),
    "renewed while the agent worked on the next chunk",
  );
  await pending;
  await it.return?.();
  stream.close();
});

test("a data step refuses anything its workload does not own", async () => {
  await seedWeb();
  await seedMain();
  const caller = await copying();
  const refusals: [string, () => Promise<unknown>][] = [
    [
      "another app's volume",
      () => moveVolume(caller, { ...WEB, volume: "deplo-other-data" }),
    ],
    [
      "the database's volume through the app",
      () => moveVolume(caller, { ...WEB, volume: MAIN_VOLUME }),
    ],
    [
      "a path it does not mount",
      () => moveHostPath(caller, { ...WEB, path: "/etc" }),
    ],
    [
      "the docker socket",
      () => moveHostPath(caller, { ...WEB, path: "/var/run/docker.sock" }),
    ],
    ["files of a database", () => moveFiles(caller, MAIN)],
    ["files of an app without any", () => moveFiles(caller, WEB)],
    [
      "an image another app built",
      () => moveImage(caller, { ...WEB, imageRef: "deplo/other:1" }),
    ],
    [
      "an image that never deployed",
      () => moveImage(caller, { ...WEB, imageRef: "deplo/web:2" }),
    ],
    ["an archive of an app built from git", () => moveUpload(caller, WEB)],
  ];
  for (const [what, attempt] of refusals)
    await assert.rejects(attempt(), { status: 409 }, what);
  assert.deepEqual(
    agent.calls.filter((c) => !c.startsWith("stop")),
    [],
    "nothing reached an export",
  );

  assert.equal(
    await text(moveVolume(caller, { ...MAIN, volume: MAIN_VOLUME })),
    `volume:${MAIN_VOLUME}|end`,
  );
  assert.equal(
    await text(
      moveHostPath(caller, {
        ...WEB,
        path: "/srv/web-uploads/",
        allowFile: true,
      }),
    ),
    "hostpath:/srv/web-uploads:true|end",
  );
  assert.equal(
    await text(moveImage(caller, { ...WEB, imageRef: "deplo/web:1" })),
    "image:deplo/web:1:false|end",
    "never removed from the old server",
  );
});

test("an uploaded app hands over the archive it builds from", async () => {
  await seedApp(db, {
    id: "prj_site",
    slug: "site",
    serverId: SRV,
    source: "upload",
    repo: null,
  });
  const dir = join(dataDir, "uploads", "prj_site", "upl_1");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "archive.tar.gz"), "the archive");
  const site: WorkloadRef = { kind: "app", id: "prj_site" };
  await db
    .update(apps)
    .set({
      uploadId: "upl_1",
      uploadFilename: "site v2.tar.gz",
      uploadPath: join(dir, "archive.tar.gz"),
      uploadSize: 11,
    })
    .where(eq(apps.id, site.id));
  const caller = await copying();
  assert.deepEqual((await moveWorkload(caller, site)).upload, {
    filename: "site v2.tar.gz",
  });
  const archive = await moveUpload(caller, site);
  assert.equal(archive.filename, "site v2.tar.gz");
  assert.equal(
    Buffer.concat(await drain(archive.chunks)).toString(),
    "the archive",
  );

  const res = await route("upload", { code: caller.code, body: site });
  assert.equal(res.status, 200);
  assert.equal(
    res.headers.get(MOVE_FILENAME_HEADER),
    encodeURIComponent("site v2.tar.gz"),
  );
  assert.equal(await res.text(), "the archive");

  await db
    .update(apps)
    .set({ uploadPath: "/etc/passwd" })
    .where(eq(apps.id, site.id));
  assert.equal((await moveWorkload(caller, site)).upload, null);
  await assert.rejects(moveUpload(caller, site), { status: 409 });
});

test("cancel starts every paused workload again and keeps only a record of the copy", async () => {
  await seedWeb();
  await seedMain();
  const caller = await copying();
  agent.running.set("web", true);
  await movePause(caller, WEB);
  await movePause(caller, MAIN);
  assert.deepEqual(await moveCancel(caller), { ok: true });
  assert.deepEqual(agent.calls, ["stop:web", "start:web"]);
  const [record] = await db.select().from(deploMoves);
  assert.equal(record.state, "cancelled");
  assert.equal(record.codeHash, null);
  assert.equal(await asAdmin(() => sourceMoveStatus()), null);
  assert.equal((await pauses()).length, 0);
  await inEveryTeam(`Cancelled copying this Deplo to ${NEW}`);
  await assert.rejects(moveHello(caller), { status: 401 });
});

test("an admin's cancel whose workload will not start keeps it for the sweep", async () => {
  await seedWeb();
  const caller = await copying();
  agent.running.set("web", true);
  await movePause(caller, WEB);
  agent.failStart = true;
  await asAdmin(() => cancelMoveCode());
  const [row] = await db.select().from(deploMoves);
  assert.equal(row.state, "cancelled");
  assert.equal(await asAdmin(() => sourceMoveStatus()), null);
  await assert.rejects(moveHello(caller), { status: 401 });
  await inEveryTeam(`Cancelled copying this Deplo to ${NEW}`);

  const next = await mint();
  assert.equal((await moveHello(next)).state, "bound");
  agent.failStart = false;
  await resumeLapsedPauses();
  assert.equal(agent.running.get("web"), true);
  assert.deepEqual(
    (await db.select().from(deploMoves)).map((m) => m.state).sort(),
    ["bound", "cancelled"],
    "a copy that started stays on record",
  );
});

test("cancelling an unused code says so", async () => {
  await mint();
  await asAdmin(() => cancelMoveCode());
  assert.equal((await db.select().from(deploMoves)).length, 0);
  await inEveryTeam("Cancelled the code to move this Deplo");
});

test("finish ends the copy: the code stops working and a new one can be made", async () => {
  await seedWeb();
  const caller = await copying();
  agent.running.set("web", true);
  await movePause(caller, WEB);
  assert.deepEqual(await moveFinish(caller), { state: "done" });
  assert.deepEqual(agent.calls, ["stop:web", "start:web"]);
  assert.equal((await pauses()).length, 0);
  assert.deepEqual(await moveFinish(caller), { state: "done" }, "idempotent");
  await inEveryTeam(`Copied this Deplo to ${NEW}`);

  for (const step of [
    () => moveHello(caller),
    () => moveWorkload(caller, WEB),
    () => movePause(caller, WEB),
    () => moveCancel(caller),
  ])
    await assert.rejects(step(), { status: 409, message: /already finished/ });

  await asAdmin(() => cancelMoveCode());
  const status = await asAdmin(() => sourceMoveStatus());
  assert.equal(status?.state, "done");
  assert.equal(status?.peerUrl, NEW);
  assert.ok(status?.finishedAt);

  await mint();
  assert.deepEqual(
    (await db.select().from(deploMoves)).map((m) => m.state).sort(),
    ["armed", "done"],
    "a finished copy stays on record",
  );
});

test("this Deplo cannot make a code while a copy lands in it", async () => {
  await db.insert(deploMoves).values({
    id: "dmv_in",
    side: "target",
    state: "copying",
    peerUrl: "https://older.example",
    startedBy: "Ada",
    createdAt: T0,
    updatedAt: T0,
  });
  invalidateFrozen();
  await assert.rejects(
    asAdmin(() => createMoveCode()),
    /being copied here from https:\/\/older\.example/,
  );
});

test("the route refuses a missing or wrong code, and a wrong peer", async () => {
  assert.equal((await route("hello")).status, 401);
  assert.equal((await route("hello", { code: "dmove_nope" })).status, 401);
  assert.equal((await route("hello", { code: "deplo_token" })).status, 401);
  assert.equal((await route("teleport", { code: "x" })).status, 404);
  for (const gone of ["freeze", "csr", "install", "thaw"])
    assert.equal((await route(gone, { code: "x" })).status, 404, gone);

  const { code } = await mint();
  assert.equal((await route("hello", { code, peer: "" })).status, 400);
  assert.equal((await route("hello", { code, raw: "{nope" })).status, 400);
  const ok = await route("hello", { code });
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { state: string }).state, "bound");

  const wrong = await route("hello", { code, peer: "intruder" });
  assert.equal(wrong.status, 403);
  assert.match((await errorOf(wrong)).error, /another/);
});

test("the route streams the dump and each data step as raw bytes", async () => {
  await seedWeb();
  const { code } = await mint();
  await route("hello", { code });
  const dump = await route("dump", { code });
  assert.equal(dump.status, 200);
  assert.equal(dump.headers.get("content-type"), "application/x-ndjson");
  assert.equal(await dump.text(), '{"kind":"begin"}\n{"kind":"end"}\n');

  const info = await route("workload", { code, body: WEB });
  assert.equal(info.status, 200);
  assert.equal(((await info.json()) as { slug: string }).slug, "web");

  const volume = await route("volume", {
    code,
    body: { ...WEB, volume: "deplo-web-data" },
  });
  assert.equal(volume.status, 200);
  assert.equal(volume.headers.get("content-type"), "application/octet-stream");
  assert.equal(await volume.text(), "volume:deplo-web-data|end");

  const notOwned = await route("volume", {
    code,
    body: { ...WEB, volume: "deplo-other-data" },
  });
  assert.equal(notOwned.status, 409, "a 404 would read as an empty volume");
  assert.deepEqual(Object.keys(await errorOf(notOwned)), ["error"]);

  agent.exportError = Object.assign(new Error("5 NOT_FOUND: no such volume"), {
    code: 5,
  });
  const missing = await route("volume", {
    code,
    body: { ...WEB, volume: "deplo-web-data" },
  });
  assert.equal(missing.status, 404, "the agent's NOT_FOUND, still JSON");
  assert.deepEqual(await errorOf(missing), {
    error: "5 NOT_FOUND: no such volume",
    code: 5,
  });

  agent.exportError = new Error("/srv/web-uploads is a file, not a directory");
  const file = await route("hostpath", {
    code,
    body: { ...WEB, path: "/srv/web-uploads", allowFile: false },
  });
  assert.equal(file.status, 409);
  assert.match((await errorOf(file)).error, /is a file, not a directory/);

  agent.exportError = null;
  agent.emptyExport = true;
  const empty = await route("files", {
    code,
    body: { kind: "app", id: "prj_none" },
  });
  assert.equal(empty.status, 404, "no such app");
  const image = await route("image", {
    code,
    body: { ...WEB, imageRef: "deplo/web:1" },
  });
  assert.equal(image.status, 204, "nothing to send");

  unreachable();
  const down = await route("pause", { code, body: WEB });
  assert.equal(down.status, 424, "never a 502: that reads as this panel down");
  assert.match((await errorOf(down)).error, /^prj_web: /);
  const downStream = await route("volume", {
    code,
    body: { ...WEB, volume: "deplo-web-data" },
  });
  assert.equal(downStream.status, 424);

  fakeAgent();
  const cancel = await route("cancel", { code });
  assert.deepEqual(await cancel.json(), { ok: true });
  assert.equal((await route("hello", { code })).status, 401);
});

test("a server's own paths and read-only binds are never copied, and the step refuses them", async () => {
  const compose = `services:
  api:
    image: api
    volumes:
      - /srv/certs:/certs:ro
      - /srv/shared:/a:ro
      - type: bind
        source: /srv/ro-long
        target: /x
        read_only: true
  worker:
    image: worker
    volumes:
      - /srv/shared:/b
      - /var/lib/docker:/docker
`;
  await seedApp(db, {
    id: "prj_sys",
    slug: "sys",
    serverId: SRV,
    source: "compose",
    repo: null,
    compose,
  });
  const host = (
    position: number,
    hostPath: string,
    readOnly = false,
  ): typeof appVolumes.$inferInsert => ({
    appId: "prj_sys",
    position,
    volumeId: `vol_${position}`,
    type: "host",
    name: `v${position}`,
    hostPath,
    mountPath: `/m${position}`,
    readOnly,
  });
  await db
    .insert(appVolumes)
    .values([
      host(0, "/srv/media"),
      host(1, "/var"),
      host(2, "/etc/nginx"),
      host(3, "/srv/../etc/passwd"),
      host(4, "/opt/deplo/data"),
      host(5, "/data/uploads"),
      host(6, "/lib64"),
      host(7, "/run/secrets"),
      host(8, "/srv/config", true),
      host(9, "/proc/1"),
    ]);
  const sys: WorkloadRef = { kind: "app", id: "prj_sys" };
  const caller = await copying();
  const info = await moveWorkload(caller, sys);
  assert.deepEqual(
    info.hostPaths.map((h) => h.path).sort(),
    ["/srv/media", "/srv/shared"],
    "a path one service writes is data, even if another reads it",
  );
  assert.deepEqual(info.skippedHostPaths?.sort(), [
    "/data/uploads",
    "/etc/nginx",
    "/etc/passwd",
    "/lib64",
    "/opt/deplo/data",
    "/proc/1",
    "/run/secrets",
    "/srv/certs",
    "/srv/config",
    "/srv/ro-long",
    "/var",
    "/var/lib/docker",
  ]);

  for (const path of [
    "/var/lib/docker",
    "/var",
    "/srv/../etc/passwd",
    "/srv/certs",
  ])
    await assert.rejects(
      moveHostPath(caller, { ...sys, path, allowFile: true }),
      { status: 409, message: /is not copied/ },
      path,
    );
  await assert.rejects(moveHostPath(caller, { ...sys, path: "/srv/certs" }), {
    message: "/srv/certs is only mounted read-only, so it is not copied.",
  });
  assert.equal(
    await text(moveHostPath(caller, { ...sys, path: "/srv/media" })),
    "hostpath:/srv/media:false|end",
  );
  assert.deepEqual(
    agent.calls.filter((c) => c.startsWith("hostpath")),
    ["hostpath:/srv/media:false"],
  );
});

test("a paused workload refuses every start, restart, deploy and redeploy until it is given back", async () => {
  await seedWeb();
  await seedMain();
  const caller = await copying();
  agent.running.set("web", true);
  agent.running.set("db-main", true);
  await movePause(caller, WEB);
  await movePause(caller, MAIN);
  agent.calls = [];

  const app =
    /^prj_web is paused while a copy of this Deplo reads its data\. Try again in a few minutes\.$/;
  for (const [what, attempt] of [
    ["start", () => startApp(WEB.id)],
    ["stop", () => stopApp(WEB.id)],
    ["redeploy", () => redeploy(WEB.id)],
    ["rebuild", () => rebuildApp(WEB.id)],
    ["reload", () => reloadApp(WEB.id)],
    [
      "a push or a deploy hook",
      () => startDeployment(WEB.id, { creator: "GitHub" }),
    ],
  ] as [string, () => Promise<unknown>][])
    await assert.rejects(asAdmin(attempt), { message: app }, what);

  const database = /^main is paused while a copy of this Deplo reads its data/;
  for (const [what, attempt] of [
    ["start", () => setDatabaseRunning(MAIN.id, true)],
    ["stop", () => setDatabaseRunning(MAIN.id, false)],
    ["restart", () => restartDatabase(MAIN.id)],
    ["redeploy", () => redeployDatabase(MAIN.id)],
    ["rebuild", () => rebuildDatabase(MAIN.id)],
  ] as [string, () => Promise<unknown>][])
    await assert.rejects(asAdmin(attempt), { message: database }, what);
  for (const [what, attempt] of [
    [
      "a password rotation",
      async () => void (await rotateDatabasePassword(MAIN.id)),
    ],
    ["a mounts edit", () => setDatabaseMounts(MAIN.id, [])],
  ] as [string, () => Promise<unknown>][])
    await assert.rejects(asAdmin(attempt), { message: database }, what);
  assert.equal(await rerouteApp(WEB.id), "deferred", "a domain edit waits");
  assert.equal(await rerouteDatabase(MAIN.id), "deferred");

  const report = await asAdmin(() => restartServerWorkloads(SRV));
  assert.equal(report.skipped, 2, "a server restart leaves them to the copy");
  assert.deepEqual(agent.calls, [], "nothing reached the server");

  await moveResume(caller, WEB);
  await asAdmin(() => startApp(WEB.id));
  assert.deepEqual(agent.calls, ["start:web", "start:web"]);

  await assert.rejects(assertNotPausedForMove("database", MAIN.id));
  await db.update(deploMovePauses).set({ leaseUntil: PAST });
  await assertNotPausedForMove("database", MAIN.id);
});

test("a second pause stops again whatever started it since", async () => {
  await seedWeb();
  await seedMain();
  const caller = await copying();
  agent.running.set("web", true);
  await movePause(caller, WEB);
  agent.running.set("web", true);
  const again = await movePause(caller, WEB);
  assert.equal(again.wasRunning, true);
  assert.ok(Date.parse(again.leaseUntil) > Date.now() + 60_000);
  assert.deepEqual(agent.calls, ["stop:web", "stop:web"]);
  assert.equal(agent.running.get("web"), false);

  assert.equal((await movePause(caller, MAIN)).wasRunning, false);
  agent.running.set("db-main", true);
  assert.equal(
    (await movePause(caller, MAIN)).wasRunning,
    true,
    "started since, so it is started again when given back",
  );
  await moveResume(caller, MAIN);
  assert.deepEqual(agent.calls.slice(2), ["stop:db-main", "start:db-main"]);
});

test("a stop that outlasts its lease starts the workload again and refuses the pause", async () => {
  await seedWeb();
  const caller = await copying();
  agent.running.set("web", true);
  agent.onStop = async () => {
    await db.update(deploMovePauses).set({ leaseUntil: PAST });
    await resumeLapsedPauses();
  };
  await assert.rejects(movePause(caller, WEB), {
    status: 409,
    message: /^prj_web was started again while it was being paused/,
  });
  assert.deepEqual(agent.calls, ["stop:web", "start:web", "start:web"]);
  assert.equal(agent.running.get("web"), true, "never left stopped");
  assert.equal((await pauses()).length, 0);
});

test("a cancel during a start that then fails still leaves the sweep a row to retry", async () => {
  await seedWeb();
  const caller = await copying();
  agent.running.set("web", true);
  await movePause(caller, WEB);
  await db.update(deploMovePauses).set({ leaseUntil: PAST });
  agent.failStart = true;
  agent.onStart = () => asAdmin(() => cancelMoveCode());
  await resumeLapsedPauses();

  assert.deepEqual(agent.calls, ["stop:web", "start:web"], "started once");
  const [move] = await db.select().from(deploMoves);
  assert.equal(move.state, "cancelled");
  const [row] = await pauses();
  assert.ok(row, "kept for the sweep");
  assert.ok(Date.parse(row.leaseUntil) <= Date.now(), "and already lapsed");

  agent.failStart = false;
  await resumeLapsedPauses();
  assert.equal(agent.running.get("web"), true);
  assert.equal((await pauses()).length, 0);
  await assert.rejects(moveHello(caller), { status: 401 });
});
