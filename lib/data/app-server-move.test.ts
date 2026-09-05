import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  apps as appsTable,
  deployments as deploymentsTable,
  domains as domainsTable,
  pendingTeardowns,
  servers as serversTable,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
  USER_1,
} from "./identity-test-helpers";
import {
  seedApp,
  seedServer,
  TRUNCATE_PROJECT_GRAPH,
  SERVER_1,
} from "./app-graph-test-helpers";
import {
  __setAgentConnectorForTest,
  AgentUnreachableError,
  type AgentConnection,
} from "../infra/agent-client";
import { deleteApp, updateAppSource } from "./apps";
import { completePendingAppMigration } from "./app-migration";
import { acceptDataCopyLoss } from "./data-copy";
import { startDeployment } from "../deploy/build";
import {
  __setRunnerForTest,
  __resetQueueForTest,
} from "../deploy/deploy-queue";

/**
 * Moving an app to another server: what the save records, and what the deploy
 * that lands there does with the data the old host still holds.
 */

let db: TestDb;
let pg: PGlite;

const SRV_A = SERVER_1;
const SRV_B = "srv_b";
const SRV_C = "srv_c";
const APP = "prj_mv";
const SLUG = "mv";
const VOL = "deplo-mv-data";
const T0 = "2026-01-01T00:00:00.000Z";

/** A gzipped tar holding one real file. */
function tarWith(name: string, content: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, "latin1");
  header.write("0000644\0", 100, "latin1");
  header.write("0000000\0", 108, "latin1");
  header.write("0000000\0", 116, "latin1");
  header.write(
    content.length.toString(8).padStart(11, "0") + "\0",
    124,
    "latin1",
  );
  header.write("00000000000\0", 136, "latin1");
  header[156] = 0x30;
  header.write("ustar\0", 257, "latin1");
  header.write("00", 263, "latin1");
  header.write("        ", 148, "latin1");
  let sum = 0;
  for (const b of header) sum += b;
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  const body = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  body.write(content, 0, "latin1");
  return gzipSync(Buffer.concat([header, body, Buffer.alloc(1024)]));
}
/** What the agent exports for a missing files dir: a header-only archive. */
const emptyTar = () => gzipSync(Buffer.alloc(1024));
const REAL = tarWith("data/real.db", "REAL");
const FILES = tarWith("files/config.yml", "CFG");

interface Host {
  stackYaml: string | null;
  volumes: Map<string, Buffer>;
  files: Buffer | null;
  running: boolean;
  calls: string[];
  fail: Partial<
    Record<"stop" | "start" | "destroy" | "read" | "import" | "dial", string>
  >;
}

function host(init: Partial<Host> = {}): Host {
  return {
    stackYaml: null,
    volumes: new Map(),
    files: null,
    running: false,
    calls: [],
    fail: {},
    ...init,
  };
}

function fleet(hosts: Record<string, Host>) {
  __setAgentConnectorForTest(async (serverId: string) => {
    const h = hosts[serverId];
    if (!h) throw new AgentUnreachableError(`no host ${serverId}`, 14);
    if (h.fail.dial) throw new AgentUnreachableError(h.fail.dial, 14);
    const conn = {
      hello: async () => ({ capabilities: ["volume-usage"] }),
      readStack: async (slug: string) => {
        h.calls.push(`read:${slug}`);
        if (h.fail.read) throw new Error(h.fail.read);
        return { exists: h.stackYaml != null, yaml: h.stackYaml ?? "" };
      },
      stopStack: async (slug: string) => {
        h.calls.push(`stop:${slug}`);
        if (h.fail.stop) return { ok: false, error: h.fail.stop };
        if (h.stackYaml == null) return { ok: false, error: "no such stack" };
        h.running = false;
        return { ok: true, error: "" };
      },
      startStack: async (slug: string) => {
        h.calls.push(`start:${slug}`);
        if (h.fail.start) return { ok: false, error: h.fail.start };
        if (h.stackYaml == null) return { ok: false, error: "no such stack" };
        h.running = true;
        return { ok: true, error: "" };
      },
      destroyStack: async (
        slug: string,
        removeVolumes?: boolean,
        reclaim?: string[],
      ) => {
        h.calls.push(`destroy:${slug}:${removeVolumes ? "v" : "keep"}`);
        if (h.fail.destroy) return { ok: false, error: h.fail.destroy };
        h.stackYaml = null;
        h.running = false;
        if (removeVolumes) h.volumes.clear();
        for (const n of reclaim ?? []) h.volumes.delete(n);
        return { ok: true, error: "" };
      },
      volumeUsage: async (names: string[]) =>
        new Map(
          names
            .filter((n) => h.volumes.has(n))
            .map((n) => [n, h.volumes.get(n)!.length] as const),
        ),
      exportVolume: async function* (name: string) {
        h.calls.push(`export:${name}`);
        const v = h.volumes.get(name);
        if (!v) {
          const e = new Error(`5 NOT_FOUND: no such volume ${name}`);
          (e as { code?: number }).code = 5;
          throw e;
        }
        yield v;
      },
      importVolume: async (
        name: string,
        _wipe: boolean,
        chunks: AsyncIterable<Buffer>,
      ) => {
        h.calls.push(`import:${name}`);
        const parts: Buffer[] = [];
        for await (const c of chunks) parts.push(Buffer.from(c));
        if (h.fail.import)
          return {
            ok: false,
            error: h.fail.import,
            bytesWritten: 0,
            sha256: "",
            dropped: { links: 0, special: 0, names: [] },
          };
        h.volumes.set(name, Buffer.concat(parts));
        return {
          ok: true,
          error: "",
          bytesWritten: 0,
          sha256: "",
          dropped: { links: 0, special: 0, names: [] },
        };
      },
      exportFiles: async function* (slug: string) {
        h.calls.push(`exportFiles:${slug}`);
        yield h.files ?? emptyTar();
      },
      importFiles: async (
        slug: string,
        _wipe: boolean,
        chunks: AsyncIterable<Buffer>,
      ) => {
        h.calls.push(`importFiles:${slug}`);
        const parts: Buffer[] = [];
        for await (const c of chunks) parts.push(Buffer.from(c));
        h.files = Buffer.concat(parts);
        return { ok: true, error: "" };
      },
      listInstances: async () => [],
      close: () => {},
    };
    return conn as unknown as AgentConnection;
  });
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  // The move's deploy is enqueued for real; the runner is not what is under test.
  __setRunnerForTest(async () => {});
});

after(async () => {
  __resetTestDb();
  __setAgentConnectorForTest();
  __resetQueueForTest();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(TRUNCATE_PROJECT_GRAPH);
  await pg.exec(TRUNCATE_IDENTITY);
  await pg.exec(
    `truncate table activities, pending_teardowns restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServer(db, SRV_A);
  await seedServer(db, SRV_B);
  await seedServer(db, SRV_C);
  await db
    .update(serversTable)
    .set({ ip: "10.0.0.2", host: "10.0.0.2" })
    .where(eq(serversTable.id, SRV_B));
  await db
    .update(serversTable)
    .set({ ip: "10.0.0.3", host: "10.0.0.3" })
    .where(eq(serversTable.id, SRV_C));
  __setAgentConnectorForTest();
});

const asOwner = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

async function row() {
  const [r] = await db.select().from(appsTable).where(eq(appsTable.id, APP));
  return r;
}

async function teardownsQueuedOn(serverId: string) {
  return db
    .select({ key: pendingTeardowns.deployKey })
    .from(pendingTeardowns)
    .where(eq(pendingTeardowns.serverId, serverId));
}

/** An app with one Storage volume, single-image, living on `serverId`. */
async function seedMovable(serverId = SRV_A) {
  await seedApp(db, { id: APP, slug: SLUG, source: "docker-image", serverId });
  await db
    .update(appsTable)
    .set({ dockerImage: "nginx:1", repoUrl: null, repoRepo: null })
    .where(eq(appsTable.id, APP));
  await pg.exec(
    `insert into app_volumes (volume_id, app_id, position, type, name, mount_path, read_only)
       values ('vol_1', '${APP}', 0, 'named', 'data', '/data', false)`,
  );
}

const move = (serverId: string) =>
  asOwner(() =>
    updateAppSource(APP, {
      source: "docker-image",
      dockerImage: "nginx:1",
      repo: null,
      serverId,
    }),
  );

const SINGLE_YAML = `services:
  app:
    image: nginx:1
    volumes:
      - ${VOL}:/data
volumes:
  ${VOL}:
    name: ${VOL}
`;

const quiet = () => {};
const collect = (into: string[]) => (level: string, text: string) =>
  void into.push(`${level}: ${text}`);

/* ------------------------------------------------------------------ */
/* What the save records                                               */
/* ------------------------------------------------------------------ */

test("a move marks the old server as the data's home and queues the deploy that carries it", async () => {
  await seedMovable();
  fleet({ [SRV_A]: host(), [SRV_B]: host() });
  await move(SRV_B);
  const r = await row();
  assert.equal(r.serverId, SRV_B);
  assert.equal(
    r.migrateFromServerId,
    SRV_A,
    "the marker no longer depends on a deployment row still existing",
  );
  const deps = await db
    .select({ serverId: deploymentsTable.serverId })
    .from(deploymentsTable)
    .where(eq(deploymentsTable.appId, APP));
  assert.deepEqual(deps, [{ serverId: SRV_B }]);
});

test("an edit that is not a move leaves a pending move alone", async () => {
  await seedMovable();
  fleet({ [SRV_A]: host(), [SRV_B]: host() });
  await move(SRV_B);
  await asOwner(() =>
    updateAppSource(APP, {
      source: "docker-image",
      dockerImage: "nginx:2",
      repo: null,
    }),
  );
  assert.equal((await row()).migrateFromServerId, SRV_A);
});

test("re-targeting a pending move keeps the data's real source and removes the stray stack", async () => {
  await seedMovable();
  const B = host({ stackYaml: SINGLE_YAML, running: true });
  fleet({ [SRV_A]: host(), [SRV_B]: B, [SRV_C]: host() });
  await move(SRV_B);
  await move(SRV_C);
  const r = await row();
  assert.equal(r.serverId, SRV_C);
  assert.equal(r.migrateFromServerId, SRV_A, "the data never left A");
  assert.ok(
    B.calls.includes(`destroy:${SLUG}:v`),
    `the half-built stack on B went: ${B.calls}`,
  );
});

test("moving back onto the data's server calls the move off", async () => {
  await seedMovable();
  fleet({ [SRV_A]: host(), [SRV_B]: host({ fail: { dial: "down" } }) });
  await move(SRV_B);
  await move(SRV_A);
  const r = await row();
  assert.equal(r.serverId, SRV_A);
  assert.equal(r.migrateFromServerId, null);
  assert.equal(
    (await teardownsQueuedOn(SRV_B)).length,
    1,
    "the unreachable intermediate host's stack is queued for teardown",
  );
});

test("a host port already published on the target refuses the move", async () => {
  await seedMovable();
  await seedApp(db, { id: "prj_other", slug: "other", serverId: SRV_B });
  await pg.exec(
    `insert into app_ports (port_id, app_id, position, published, target, protocol)
       values ('prt_1', '${APP}', 0, 8080, 80, 'tcp'),
              ('prt_2', 'prj_other', 0, 8080, 80, 'tcp')`,
  );
  await assert.rejects(() => move(SRV_B), /Port 8080 is already published/);
  assert.equal((await row()).serverId, SRV_A);
});

test("an app whose import copy failed is not moved until that is resolved", async () => {
  await seedMovable();
  await db
    .update(appsTable)
    .set({ dataCopyError: "the source was off" })
    .where(eq(appsTable.id, APP));
  await assert.rejects(() => move(SRV_B), /did not come across/);
});

/* ------------------------------------------------------------------ */
/* What the deploy on the new server does with the data                */
/* ------------------------------------------------------------------ */

async function pendingMove(opts: { from?: string; to?: string } = {}) {
  await seedMovable(opts.to ?? SRV_B);
  await db
    .update(appsTable)
    .set({ migrateFromServerId: opts.from ?? SRV_A })
    .where(eq(appsTable.id, APP));
}

test("the data crosses, the new stack comes back up on it, the old host is torn down", async () => {
  await pendingMove();
  const A = host({
    stackYaml: SINGLE_YAML,
    running: true,
    volumes: new Map([[VOL, REAL]]),
    files: FILES,
  });
  const B = host({ stackYaml: SINGLE_YAML, running: true });
  fleet({ [SRV_A]: A, [SRV_B]: B });
  const lines: string[] = [];
  const outcome = await completePendingAppMigration(APP, SRV_B, collect(lines));
  assert.equal(outcome, "done");
  assert.ok(
    B.volumes.get(VOL)?.equals(REAL),
    "the volume arrived byte for byte",
  );
  assert.equal(B.running, true);
  assert.equal(A.stackYaml, null, "the old stack is gone");
  assert.ok(A.calls.includes(`destroy:${SLUG}:v`), `${A.calls}`);
  assert.equal((await row()).migrateFromServerId, null);
  assert.equal(
    B.calls.includes(`importFiles:${SLUG}`),
    false,
    "a single-image app without mounts has no files dir to carry",
  );
});

test("a failed copy rolls the move back: the app is on its old server, running, and the new stack is gone", async () => {
  await pendingMove();
  await db
    .update(appsTable)
    .set({
      buildServerId: SRV_B,
      productionUrl: "https://mv-word-0a000002.nip.io",
    })
    .where(eq(appsTable.id, APP));
  await db.insert(domainsTable).values({
    id: "dom_1",
    appId: APP,
    name: "mv-word-0a000002.nip.io",
    status: "valid",
    isPrimary: true,
    ssl: false,
    source: "auto",
    createdAt: T0,
  });
  const A = host({
    stackYaml: SINGLE_YAML,
    running: true,
    volumes: new Map([[VOL, REAL]]),
  });
  const B = host({
    stackYaml: SINGLE_YAML,
    running: true,
    fail: { import: "disk full" },
  });
  fleet({ [SRV_A]: A, [SRV_B]: B });
  const lines: string[] = [];
  const outcome = await completePendingAppMigration(APP, SRV_B, collect(lines));
  assert.equal(outcome, "rolled-back");
  const r = await row();
  assert.equal(r.serverId, SRV_A);
  assert.equal(r.migrateFromServerId, null);
  assert.equal(r.status, "active");
  assert.equal(r.buildServerId, SRV_A, "the build server followed it back");
  assert.equal(r.productionUrl, "https://mv-word-0a000001.nip.io");
  const [dom] = await db.select().from(domainsTable);
  assert.equal(dom.name, "mv-word-0a000001.nip.io", "the auto host too");
  assert.equal(A.running, true, "the old stack was started again");
  assert.ok(A.volumes.get(VOL)?.equals(REAL), "and its data is untouched");
  assert.equal(B.stackYaml, null, "the half-built new stack is gone");
  assert.match(lines.at(-1)!, /rolled back.*still on srv_1/);
  assert.equal(
    lines.some((l) => /move the app back/.test(l)),
    false,
    "no advice that would copy the empty side over the full one",
  );
});

test("an unreachable old server holds the move: stopped on the new server, blocked, retried by the next deploy", async () => {
  await pendingMove();
  const B = host({ stackYaml: SINGLE_YAML, running: true });
  fleet({
    [SRV_A]: host({ fail: { dial: "connect ECONNREFUSED" } }),
    [SRV_B]: B,
  });
  const outcome = await completePendingAppMigration(APP, SRV_B, quiet);
  assert.equal(outcome, "held");
  const r = await row();
  assert.equal(r.serverId, SRV_B, "nothing to go back to");
  assert.equal(
    r.migrateFromServerId,
    SRV_A,
    "the marker survives: A still has the data",
  );
  assert.match(r.dataCopyError, /srv_1 could not be reached/);
  assert.equal(r.status, "error");
  assert.equal(
    B.running,
    false,
    "not serving an empty app as if nothing happened",
  );

  // The next deploy is the retry: not refused by the copy block.
  await assert.doesNotReject(() =>
    asOwner(() => startDeployment(APP, { creator: "o" })),
  );
  // Without the marker the same block refuses, as it does for an import.
  await db
    .update(appsTable)
    .set({ migrateFromServerId: null })
    .where(eq(appsTable.id, APP));
  await assert.rejects(
    () => asOwner(() => startDeployment(APP, { creator: "o" })),
    /did not come across/,
  );
});

test("accepting the loss of a held move ends it and queues the old host's stack for teardown", async () => {
  await pendingMove();
  fleet({
    [SRV_A]: host({ fail: { dial: "down" } }),
    [SRV_B]: host({ stackYaml: SINGLE_YAML }),
  });
  await completePendingAppMigration(APP, SRV_B, quiet);
  await asOwner(() => acceptDataCopyLoss({ kind: "app", id: APP }));
  const r = await row();
  assert.equal(r.dataCopyError, "");
  assert.equal(r.migrateFromServerId, null);
  assert.equal((await teardownsQueuedOn(SRV_A)).length, 1);
});

test("a retry after a hold copies the data once the old server answers", async () => {
  await pendingMove();
  const A = host({
    stackYaml: SINGLE_YAML,
    running: true,
    volumes: new Map([[VOL, REAL]]),
    fail: { dial: "down" },
  });
  const B = host({ stackYaml: SINGLE_YAML, running: true });
  fleet({ [SRV_A]: A, [SRV_B]: B });
  assert.equal(await completePendingAppMigration(APP, SRV_B, quiet), "held");
  A.fail = {};
  assert.equal(await completePendingAppMigration(APP, SRV_B, quiet), "done");
  const r = await row();
  assert.equal(
    r.dataCopyError,
    "",
    "the hold is lifted by the copy that worked",
  );
  assert.equal(r.migrateFromServerId, null);
  assert.ok(B.volumes.get(VOL)?.equals(REAL));
});

test("a deploy that lands on a server the app has since left removes its stray stack and copies nothing", async () => {
  // Moved A → B, then re-targeted to C before B's deploy finished.
  await pendingMove({ to: SRV_C });
  const A = host({
    stackYaml: SINGLE_YAML,
    running: true,
    volumes: new Map([[VOL, REAL]]),
  });
  const B = host({ stackYaml: SINGLE_YAML, running: true });
  fleet({ [SRV_A]: A, [SRV_B]: B, [SRV_C]: host({ stackYaml: SINGLE_YAML }) });
  const outcome = await completePendingAppMigration(APP, SRV_B, quiet);
  assert.equal(outcome, "nothing");
  assert.equal(B.stackYaml, null, "the stray stack on B is gone");
  assert.deepEqual(A.calls, [], "A was not touched");
  assert.equal(
    (await row()).migrateFromServerId,
    SRV_A,
    "the move is still pending",
  );
});

test("an app that never ran on the old server moves without stopping anything", async () => {
  await pendingMove();
  const A = host();
  const B = host({ stackYaml: SINGLE_YAML, running: true });
  fleet({ [SRV_A]: A, [SRV_B]: B });
  const outcome = await completePendingAppMigration(APP, SRV_B, quiet);
  assert.equal(outcome, "nothing");
  assert.equal(B.running, true);
  assert.deepEqual(B.calls, [], "the fresh stack was left alone");
  assert.equal((await row()).migrateFromServerId, null);
});

test("an imported app - data on the old host, never deployed there - still carries its volume", async () => {
  await pendingMove();
  const A = host({ volumes: new Map([[VOL, REAL]]) });
  const B = host({ stackYaml: SINGLE_YAML, running: true });
  fleet({ [SRV_A]: A, [SRV_B]: B });
  const outcome = await completePendingAppMigration(APP, SRV_B, quiet);
  assert.equal(outcome, "done");
  assert.ok(B.volumes.get(VOL)?.equals(REAL));
  assert.equal(
    A.calls.includes(`stop:${SLUG}`),
    false,
    "no stack to stop there",
  );
  assert.equal(A.volumes.has(VOL), false, "the imported volume was reclaimed");
});

test("a volume not found where Deplo looked keeps the old host's volumes", async () => {
  await pendingMove();
  const A = host({
    stackYaml: SINGLE_YAML,
    running: true,
    volumes: new Map([["deplo-mv-other", REAL]]),
  });
  const B = host({ stackYaml: SINGLE_YAML, running: true });
  fleet({ [SRV_A]: A, [SRV_B]: B });
  const lines: string[] = [];
  const outcome = await completePendingAppMigration(APP, SRV_B, collect(lines));
  assert.equal(outcome, "done");
  assert.ok(A.calls.includes(`destroy:${SLUG}:keep`), `${A.calls}`);
  assert.equal(
    A.volumes.has("deplo-mv-other"),
    true,
    "nothing on A was reclaimed",
  );
  assert.ok(lines.some((l) => /was not on srv_1/.test(l)));
});

test("what a move leaves behind on purpose is said in the log", async () => {
  await pendingMove();
  await pg.exec(
    `insert into app_volumes (volume_id, app_id, position, type, name, mount_path, host_path, read_only)
       values ('vol_2', '${APP}', 1, 'host', 'shared', '/mnt/shared', '/srv/shared', false)`,
  );
  const A = host({
    stackYaml: SINGLE_YAML,
    running: true,
    volumes: new Map([[VOL, REAL]]),
  });
  fleet({
    [SRV_A]: A,
    [SRV_B]: host({ stackYaml: SINGLE_YAML, running: true }),
  });
  const lines: string[] = [];
  await completePendingAppMigration(APP, SRV_B, collect(lines));
  assert.ok(
    lines.some((l) => /host path \/srv\/shared is not copied/.test(l)),
    lines.join("\n"),
  );
});

test("an empty files dir on the old host never wipes the one the deploy just rendered", async () => {
  await pendingMove();
  await pg.exec(
    `insert into app_mounts (app_id, position, file_path, content)
       values ('${APP}', 0, 'config.yml', 'a: 1')`,
  );
  const A = host({
    stackYaml: SINGLE_YAML,
    running: true,
    volumes: new Map([[VOL, REAL]]),
  });
  const B = host({ stackYaml: SINGLE_YAML, running: true, files: FILES });
  fleet({ [SRV_A]: A, [SRV_B]: B });
  assert.equal(await completePendingAppMigration(APP, SRV_B, quiet), "done");
  assert.equal(B.calls.includes(`importFiles:${SLUG}`), false);
  assert.ok(B.files?.equals(FILES), "B's rendered files are intact");
});

test("deleting an app mid-move tears its stack down on the old host too", async () => {
  await pendingMove();
  const A = host({
    stackYaml: SINGLE_YAML,
    running: true,
    volumes: new Map([[VOL, REAL]]),
  });
  const B = host({ stackYaml: SINGLE_YAML, running: true });
  fleet({ [SRV_A]: A, [SRV_B]: B });
  await asOwner(() => deleteApp(APP));
  assert.equal(A.stackYaml, null, `the old host's stack went too: ${A.calls}`);
  assert.equal(B.stackYaml, null);
});
