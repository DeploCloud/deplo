import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { inspect } from "node:util";

import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";

process.env.DEPLO_DATA_DIR = mkdtempSync(join(tmpdir(), "deplo-move-"));

import { runWithIdentity } from "../../auth/request-context";
import { decryptSecret, encryptSecret } from "../../crypto";
import { __resetTestDb, __setTestDb } from "../../db/client";
import { makeTestDb, type TestDb } from "../../db/test-harness";
import { activities } from "../../db/schema/control-plane/activity";
import { apps as appsTable } from "../../db/schema/control-plane/apps";
import { databases as databasesTable } from "../../db/schema/control-plane/databases";
import {
  deployments as deploymentsTable,
  pendingTeardowns,
} from "../../db/schema/control-plane/deployments";
import {
  deploMoves,
  deploMoveServers,
  deploMoveWorkloads,
} from "../../db/schema/control-plane/deplo-move";
import { users } from "../../db/schema/control-plane/identity";
import { migrationRuns } from "../../db/schema/control-plane/migration";
import { servers as serversTable } from "../../db/schema/control-plane/servers";
import type { MoveWorkloadInfo } from "../../deplo-move/protocol";
import { __setAgentConnectorForTest } from "../../infra/agent-client/connect";
import { instanceFingerprint } from "../../migration/deplo/instance";
import {
  __resetMigrationFetchForTest,
  __setMigrationFetchForTest,
} from "../../migration/transport";
import { seedApp, seedDeployment } from "../app-graph-test-helpers";
import { seedDatabase } from "../backup-test-helpers";
import { seedIdentity, TEAM_A, USER_1 } from "../identity-test-helpers";
import { seedServerRow } from "../infra-test-helpers";
import { dumpInstance } from "./dump";
import { instanceFrozen, invalidateFrozen } from "./freeze";
import type { RestoreOptions } from "./restore";
import {
  COPY_FAILED,
  MIGRATION_STOPPED_NOTE,
  SKIPPED_NOTE,
  WORKLOAD_FAILED,
  __setAfterMoveForTest,
  __setRestorerForTest,
  __waitForMoveForTest,
  resumeDeploMoves,
} from "./runner";
import { invalidateSchedulesPaused, schedulesPaused } from "./schedules";
import {
  SKIPPED_BY_HAND,
  cancelMove,
  connectMove,
  finishMoveWithoutSource,
  moveBanner,
  moveStatus,
  retryMove,
  skipMoveWorkload,
  startMove,
} from "./target";
import {
  MOVE_CODE,
  NEW,
  OLD,
  SELF_IP,
  dumpOf,
  fakeAgents,
  fakeOldDeplo,
  helloOf,
  stepsCalled,
  summary,
  tarGz,
  workloadInfo,
  type FakeOldDeplo,
} from "./target-test-helpers";
import { __setDeployStarterForTest } from "./workload-copy";

let db: TestDb;
let pg: PGlite;
let agents: ReturnType<typeof fakeAgents>;
let old: FakeOldDeplo;
let afterMoves = 0;
let restored: RestoreOptions[] = [];
let deploys: {
  appId: string;
  rollbackOf: string | null;
  image: string | null;
}[] = [];
let deployStatus = "ready";
// Runs after the stub copy lands, to give one test rows of its own.
let afterRestore: (opts: RestoreOptions) => Promise<void> = async () => {};

const T0 = "2026-01-01T00:00:00.000Z";
const DB_VOLUME = "deplo-db-main_db-main-data";
const WEB_IMAGE = "deplo/web:dpl_web1";
const UPLOAD_PATH = "/data/uploads/prj_site/upl_abc/archive.tar.gz";

const WORKLOADS: MoveWorkloadInfo[] = [
  workloadInfo({
    kind: "database",
    id: "db_main",
    name: "main",
    slug: "db-main",
    volumes: [DB_VOLUME],
  }),
  workloadInfo({
    kind: "app",
    id: "prj_web",
    name: "web",
    slug: "web",
    volumes: ["deplo-web_data"],
    files: true,
    hostPaths: [{ path: "/srv/web-uploads", allowFile: false }],
    image: { ref: WEB_IMAGE, deploymentId: "dpl_web1" },
  }),
  workloadInfo({
    kind: "app",
    id: "prj_site",
    name: "site",
    slug: "site",
    running: false,
    upload: { filename: "site.tar.gz" },
  }),
];

const DATA = {
  [`volume:${DB_VOLUME}`]: tarGz("PG_VERSION", "16"),
  "volume:deplo-web_data": tarGz("index.html", "<h1>hi</h1>"),
  "files:prj_web": tarGz("files/notes.txt", "notes"),
  "hostpath:/srv/web-uploads": tarGz("photo.jpg", "jpeg"),
  [`image:${WEB_IMAGE}`]: Buffer.from("image-bytes"),
  "upload:prj_site": Buffer.from("archive-bytes"),
};

// Stands in for the copy engine: the old Deplo's rows land with their servers mapped onto this one's.
async function sourceRestore(
  lines: AsyncIterable<string>,
  opts: RestoreOptions,
): Promise<{ rows: number; unreadable: number }> {
  restored.push(opts);
  for await (const line of lines) void line;
  await pg.exec(
    "truncate table memberships, membership_capabilities, users, teams cascade",
  );
  await seedIdentity(db, {
    teams: [
      { id: "team_src1", slug: "src1" },
      { id: "team_src2", slug: "src2" },
    ],
    users: [{ id: "user_src", teamId: "team_src1", role: "owner" }],
  });
  const serverId = opts.serverMap.get("srv_web")!;
  await seedDatabase(db, {
    id: "db_main",
    teamId: "team_src1",
    serverId,
    name: "main",
  });
  for (const [id, slug] of [
    ["prj_web", "web"],
    ["prj_site", "site"],
  ])
    await seedApp(db, { id, slug, teamId: "team_src1", serverId });
  await seedDeployment(db, {
    id: "dpl_web1",
    appId: "prj_web",
    imageRef: WEB_IMAGE,
    serverId,
  });
  await seedDeployment(db, { id: "dpl_site1", appId: "prj_site", serverId });
  await seedDeployment(db, {
    id: "dpl_inflight",
    appId: "prj_web",
    status: "queued",
    serverId: "srv_web",
  });
  await pg.exec(`
    update apps set name = slug;
    update apps set latest_deployment_id = 'dpl_web1' where id = 'prj_web';
    update apps set latest_deployment_id = 'dpl_site1', source = 'upload',
      upload_id = 'upl_abc', upload_filename = 'site.tar.gz',
      upload_path = '${UPLOAD_PATH}' where id = 'prj_site';`);
  await afterRestore(opts);
  return { rows: 12, unreadable: 0 };
}

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  process.env.DEPLO_PUBLIC_URL = NEW;
  process.env.DEPLO_SERVER_IP = SELF_IP;
});

after(async () => {
  __resetMigrationFetchForTest();
  __setAgentConnectorForTest();
  __setRestorerForTest();
  __setAfterMoveForTest();
  __setDeployStarterForTest();
  invalidateFrozen();
  invalidateSchedulesPaused();
  __resetTestDb();
  await pg.close();
  rmSync(process.env.DEPLO_DATA_DIR!, { recursive: true, force: true });
});

beforeEach(async () => {
  await pg.exec(`truncate table deplo_moves, deplo_move_servers,
    deplo_move_workloads, servers, apps, databases, deployments, activities,
    registration_links, membership_capabilities, memberships, users, teams,
    instance_settings, pending_teardowns, migration_runs
    restart identity cascade;`);
  await seedIdentity(db, {
    teams: [{ id: TEAM_A, slug: "alpha" }],
    users: [{ id: USER_1, teamId: TEAM_A, role: "owner" }],
  });
  await seedServerRow(db, {
    id: "srv_self",
    name: "this-machine",
    ip: SELF_IP,
    host: SELF_IP,
  });
  agents = fakeAgents();
  __setAgentConnectorForTest(agents.connector);
  old = fakeOldDeplo({
    hello: helloOf({
      counts: { teams: 2, users: 1, apps: 2, databases: 1, servers: 1 },
      servers: [summary({ id: "srv_web", name: "web", apps: 2, databases: 1 })],
    }),
    dump: dumpOf({}),
    workloads: WORKLOADS,
    data: { ...DATA },
  });
  __setMigrationFetchForTest(old.fetch);
  restored = [];
  __setRestorerForTest(sourceRestore);
  deploys = [];
  deployStatus = "ready";
  __setDeployStarterForTest(async (appId, opts) => {
    deploys.push({
      appId,
      rollbackOf: opts.rollback?.deploymentId ?? null,
      image: opts.rollback?.imageRef ?? null,
    });
    const id = `dpl_move${deploys.length}`;
    await seedDeployment(db, {
      id,
      appId,
      status: deployStatus as "ready",
      createdAt: new Date().toISOString(),
    });
    return id;
  });
  afterMoves = 0;
  __setAfterMoveForTest(async () => {
    afterMoves += 1;
  });
  afterRestore = async () => {};
  invalidateFrozen();
  invalidateSchedulesPaused();
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);
// An instance admin of the old Deplo, signed in here once the copy landed.
const asCopiedAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: "user_src", teamId: "team_src1" }, fn);

async function startedMove(): Promise<string> {
  const preview = await asAdmin(() =>
    connectMove({ url: OLD, code: MOVE_CODE }),
  );
  assert.equal(preview.canStart, true, preview.problems.join(" "));
  await asAdmin(() =>
    startMove(preview.id, [{ from: "srv_web", to: "srv_self" }]),
  );
  await __waitForMoveForTest();
  return preview.id;
}

async function until(cond: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(20);
  }
}

const oldDeploGone = () =>
  __setMigrationFetchForTest(async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
  });

async function quietly<T>(fn: () => Promise<T>): Promise<[T, string]> {
  const said: string[] = [];
  const saved = { error: console.error, warn: console.warn, log: console.log };
  for (const k of ["error", "warn", "log"] as const)
    console[k] = (...args: unknown[]) =>
      said.push(
        args
          .map((a) => (typeof a === "string" ? a : inspect(a, { depth: 8 })))
          .join(" "),
      );
  try {
    return [await fn(), said.join("\n")];
  } finally {
    Object.assign(console, saved);
  }
}

const workloadStates = async (id: string) =>
  (await moveStatus(id))?.workloads.map((w) => [w.id, w.state]);

test("a move copies, deploys every workload here with its data, databases first, and finishes", async () => {
  const id = await startedMove();

  const status = await moveStatus(id);
  assert.equal(status?.state, "done", status?.error ?? "");
  assert.deepEqual(
    status?.steps.map((s) => s.state),
    ["done", "done", "done"],
  );
  assert.equal(status?.rowsCopied, 12);
  assert.deepEqual(
    status?.workloads.map((w) => [w.kind, w.id, w.state, w.error]),
    [
      ["database", "db_main", "done", ""],
      ["app", "prj_site", "done", ""],
      ["app", "prj_web", "done", ""],
    ],
  );
  assert.deepEqual(
    restored.map((r) => [[...r.serverMap], r.peerUrl]),
    [[[["srv_web", "srv_self"]], OLD]],
  );

  assert.deepEqual(stepsCalled(old), [
    "hello",
    "hello",
    "hello",
    "dump",
    "workload:db_main",
    "pause:db_main",
    "volume:db_main",
    "volume:db_main",
    "resume:db_main",
    "workload:prj_site",
    "upload:prj_site",
    "workload:prj_web",
    "image:prj_web",
    "pause:prj_web",
    "volume:prj_web",
    "volume:prj_web",
    "files:prj_web",
    "files:prj_web",
    "hostpath:prj_web",
    "hostpath:prj_web",
    "resume:prj_web",
    "finish",
  ]);
  for (const call of old.calls) {
    assert.equal(call.headers.get("authorization"), `Bearer ${MOVE_CODE}`);
    assert.equal(call.headers.get("x-deplo-move-peer"), instanceFingerprint());
    assert.equal(call.headers.get("x-deplo-move-peer-url"), NEW);
  }
  assert.deepEqual([...old.paused], [], "everything paused there was resumed");

  assert.deepEqual(agents.calls, [
    "reroute:srv_self:db-main",
    "stop:srv_self:db-main",
    `volume:srv_self:${DB_VOLUME}`,
    "start:srv_self:db-main",
    "stop:srv_self:site",
    `image:srv_self:${WEB_IMAGE}`,
    "stop:srv_self:web",
    "volume:srv_self:deplo-web_data",
    "files:srv_self:web",
    "hostpath:srv_self:/srv/web-uploads",
    "start:srv_self:web",
  ]);
  for (const [key, bytes] of [
    [`volume:srv_self:${DB_VOLUME}`, DATA[`volume:${DB_VOLUME}`]],
    [`image:srv_self:${WEB_IMAGE}`, DATA[`image:${WEB_IMAGE}`]],
    ["hostpath:srv_self:/srv/web-uploads", DATA["hostpath:/srv/web-uploads"]],
  ] as const)
    assert.deepEqual(agents.received.get(key), bytes, key);

  assert.deepEqual(deploys, [
    { appId: "prj_site", rollbackOf: null, image: null },
    { appId: "prj_web", rollbackOf: "dpl_web1", image: WEB_IMAGE },
  ]);
  const [site] = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "prj_site"));
  assert.equal(site.status, "idle", "it was stopped there, so it is here");
  assert.match(site.uploadPath ?? "", /prj_site\/upl_abc\/archive\.tar\.gz$/);
  assert.equal(readFileSync(site.uploadPath!, "utf8"), "archive-bytes");
  const [main] = await db.select().from(databasesTable);
  assert.equal(main.status, "running");
  const [inflight] = await db
    .select()
    .from(deploymentsTable)
    .where(eq(deploymentsTable.id, "dpl_inflight"));
  assert.equal(
    inflight.status,
    "canceled",
    "the old Deplo's deploy stays there",
  );

  const notes = await db.select().from(activities);
  assert.deepEqual(
    notes
      .filter((a) => a.message.startsWith("Copied this Deplo"))
      .map((a) => [a.teamId, a.message])
      .sort(),
    [
      ["team_src1", `Copied this Deplo here from ${OLD}`],
      ["team_src2", `Copied this Deplo here from ${OLD}`],
    ],
  );
  assert.equal(afterMoves, 1);
  invalidateFrozen();
  assert.equal(await instanceFrozen(), null);
  assert.equal(await schedulesPaused(), true, "schedules wait for an admin");
  const banner = await runWithIdentity(
    { userId: "user_src", teamId: "team_src1" },
    () => moveBanner(),
  );
  assert.deepEqual(banner, {
    phase: null,
    peerUrl: "",
    progressPath: null,
    schedulesPaused: true,
    canResumeSchedules: true,
  });
});

test("a workload that fails is recorded, the rest still go, and a retry finishes it", async () => {
  old.fail.volume = {
    status: 424,
    error: "web: The server agent did not answer.",
    id: "db_main",
    times: 1,
  };
  const id = await startedMove();

  let status = await moveStatus(id);
  assert.equal(status?.state, "failed");
  assert.equal(
    status?.error,
    "1 app or database could not be copied: see why below, then try again.",
  );
  assert.deepEqual(
    status?.workloads.map((w) => [w.id, w.state, w.error]),
    [
      ["db_main", "failed", "web: The server agent did not answer."],
      ["prj_site", "done", ""],
      ["prj_web", "done", ""],
    ],
  );
  assert.deepEqual(
    status?.steps.map((s) => s.state),
    ["done", "failed", "waiting"],
  );
  assert.equal(status?.canRetry, true, "a retry stays public");
  assert.equal(status?.canCancel, false, "the copy landed: admins only");
  assert.equal(status?.canFinishWithoutSource, false);
  assert.equal(status?.canSkip, false);
  assert.equal(status?.needsAdminSignIn, true);
  const asAdminSees = await asCopiedAdmin(() => moveStatus(id));
  assert.equal(asAdminSees?.canCancel, true);
  assert.equal(asAdminSees?.canFinishWithoutSource, true);
  assert.equal(asAdminSees?.canSkip, true);
  assert.equal(asAdminSees?.needsAdminSignIn, false);
  assert.deepEqual([...old.paused], [], "the failed one was resumed there");
  assert.equal(stepsCalled(old).includes("finish"), false);
  invalidateFrozen();
  assert.equal(await instanceFrozen(), null, "only the copy freezes");

  const before = old.calls.length;
  await retryMove(id);
  await __waitForMoveForTest();
  status = await moveStatus(id);
  assert.equal(status?.state, "done", status?.error ?? "");
  assert.deepEqual(stepsCalled(old).slice(before), [
    "workload:db_main",
    "pause:db_main",
    "volume:db_main",
    "volume:db_main",
    "resume:db_main",
    "finish",
  ]);
  assert.equal(deploys.length, 2, "nothing done is deployed again");
});

test("a workload whose lease lapsed mid-copy is failed, never taken as copied", async () => {
  old.lapsed.add("prj_web");
  const id = await startedMove();
  const status = await moveStatus(id);
  assert.equal(status?.state, "failed");
  assert.deepEqual(
    status?.workloads.map((w) => [w.id, w.state, w.error]),
    [
      ["db_main", "done", ""],
      ["prj_site", "done", ""],
      [
        "prj_web",
        "failed",
        "The old Deplo started it again before its data finished copying. Try again.",
      ],
    ],
  );
  assert.equal(
    agents.calls.includes("start:srv_self:web"),
    false,
    "a torn copy is not started here",
  );
});

test("a deploy that fails here fails only its own workload", async () => {
  deployStatus = "error";
  const id = await startedMove();
  const status = await moveStatus(id);
  assert.equal(status?.state, "failed");
  assert.deepEqual(
    status?.workloads.map((w) => [w.id, w.state, w.error]),
    [
      ["db_main", "done", ""],
      [
        "prj_site",
        "failed",
        "site did not deploy here: open its deployments to see why.",
      ],
      [
        "prj_web",
        "failed",
        "web did not deploy here: open its deployments to see why.",
      ],
    ],
  );
  assert.equal(stepsCalled(old).includes("pause:prj_web"), false);
});

test("cancelling after the copy tears down what was deployed here, tells the old Deplo and wipes", async () => {
  old.fail.workload = { status: 409, error: "Not now.", id: "prj_web" };
  const id = await startedMove();
  assert.equal((await moveStatus(id))?.state, "failed");
  agents.calls.length = 0;

  await assert.rejects(() => cancelMove(id), /Unauthorized/);
  await db.insert(users).values({
    id: "user_member",
    email: "member@example.io",
    username: "member",
    name: "member",
    role: "member",
    isInstanceAdmin: false,
    avatarColor: "#abc",
    createdAt: T0,
    updatedAt: T0,
  });
  await assert.rejects(
    () =>
      runWithIdentity({ userId: "user_member", teamId: "team_src1" }, () =>
        cancelMove(id),
      ),
    /Only an instance admin can do that/,
  );
  assert.equal((await moveStatus(id))?.state, "failed", "nothing changed");
  assert.equal(stepsCalled(old).includes("cancel"), false);

  const status = await asCopiedAdmin(() => cancelMove(id));
  assert.equal(status.state, "cancelled");
  assert.equal(status.error, "");
  assert.equal(stepsCalled(old).at(-1), "cancel");
  assert.deepEqual(agents.calls.sort(), [
    "destroy:srv_self:db-main",
    "destroy:srv_self:site",
    "destroy:srv_self:web",
  ]);
  assert.equal((await db.select().from(users)).length, 0);
  assert.equal(await db.$count(appsTable), 0);
  assert.match(status.setupPath ?? "", /^\/setup\?key=.+/);
  assert.ok(
    (await db.select().from(serversTable)).some((s) => s.id === "srv_self"),
    "this Deplo's own servers stay",
  );
  invalidateSchedulesPaused();
  assert.equal(await schedulesPaused(), false);
  invalidateFrozen();
  assert.equal(await instanceFrozen(), null);
});

test("cancelling while the move runs stops it first", async () => {
  deployStatus = "building";
  const preview = await asAdmin(() =>
    connectMove({ url: OLD, code: MOVE_CODE }),
  );
  await asAdmin(() => startMove(preview.id));
  await until(async () => deploys.length > 0);

  const status = await asCopiedAdmin(() => cancelMove(preview.id));
  assert.equal(status.state, "cancelled");
  assert.equal(stepsCalled(old).at(-1), "cancel");
  assert.ok(agents.calls.includes("destroy:srv_self:site"));
  assert.ok(
    agents.calls.includes("destroy:srv_self:web"),
    "web too, though it was never reached: removing nothing is harmless",
  );
  assert.equal((await db.select().from(users)).length, 0);
});

test("cancelling a move that never started keeps this Deplo's own account", async () => {
  const preview = await asAdmin(() =>
    connectMove({ url: OLD, code: MOVE_CODE }),
  );
  const status = await cancelMove(preview.id);
  assert.equal(status.state, "cancelled");
  assert.equal(stepsCalled(old).at(-1), "cancel");
  assert.equal((await db.select().from(users)).length, 1);
  assert.equal(status.setupPath, null);
});

test("cancelling when the old Deplo is unreachable still cancels here, and says so", async () => {
  const preview = await asAdmin(() =>
    connectMove({ url: OLD, code: MOVE_CODE }),
  );
  oldDeploGone();
  const status = await cancelMove(preview.id);
  assert.equal(status.state, "cancelled");
  assert.match(status.error, /cancel the move there too/);
});

test("with the old Deplo gone, the move finishes without what never came across", async () => {
  old.fail.workload = { status: 409, error: "Not now.", id: "prj_web" };
  const id = await startedMove();
  const before = await asCopiedAdmin(() => moveStatus(id));
  assert.equal(before?.state, "failed");
  assert.equal(before?.canFinishWithoutSource, true);

  await assert.rejects(
    () => asCopiedAdmin(() => finishMoveWithoutSource(id)),
    /The old Deplo answers again: try again instead\./,
  );
  oldDeploGone();
  await assert.rejects(() => finishMoveWithoutSource(id), /Unauthorized/);
  const status = await asCopiedAdmin(() => finishMoveWithoutSource(id));
  assert.equal(status.state, "done");
  assert.equal(
    status.error,
    "Finished without the old Deplo: 1 app or database was left out.",
  );
  assert.deepEqual(
    status.workloads.map((w) => [w.id, w.state, w.error]),
    [
      ["db_main", "done", ""],
      ["prj_site", "done", ""],
      ["prj_web", "skipped", SKIPPED_NOTE],
    ],
  );
  assert.deepEqual(
    status.steps.map((s) => s.state),
    ["done", "failed", "done"],
  );
  assert.deepEqual(
    deploys.map((d) => d.appId),
    ["prj_site"],
    "web is left out, never deployed empty",
  );
  assert.ok(status.finishedAt);
  assert.equal(status.canFinishWithoutSource, false);
  assert.equal(status.canCancel, false);
  const notes = await db.select().from(activities);
  assert.ok(
    notes.some((a) =>
      /without the old one at https:\/\/old\.deplo\.test: 1 app or database was left out$/.test(
        a.message,
      ),
    ),
  );
  await assert.rejects(() => finishMoveWithoutSource(id), /already finished/);
  await assert.rejects(() => cancelMove(id), /can no longer be cancelled/);
});

test("a cut-off copy fails the copy step, changes nothing, and a retry copies again", async () => {
  old.dump = dumpOf({}).slice(0, -1);
  const id = await startedMove();

  let status = await moveStatus(id);
  assert.equal(status?.state, "failed");
  assert.match(status?.error ?? "", /cut off/);
  assert.deepEqual(
    status?.steps.map((s) => s.state),
    ["failed", "waiting", "waiting"],
  );
  assert.equal(status?.canFinishWithoutSource, false);

  old.dump = dumpOf({});
  await retryMove(id);
  await __waitForMoveForTest();
  status = await moveStatus(id);
  assert.equal(status?.state, "done", status?.error ?? "");
  assert.equal(stepsCalled(old).filter((s) => s === "dump").length, 2);
});

test("a move left half-way resumes on boot from the first workload not copied", async () => {
  await seedIdentity(db, {
    teams: [{ id: "team_src1", slug: "src1" }],
    users: [{ id: "user_src", teamId: "team_src1", role: "owner" }],
  });
  await seedApp(db, {
    id: "prj_site",
    slug: "site",
    teamId: "team_src1",
    serverId: "srv_self",
  });
  await seedDeployment(db, { id: "dpl_site1", appId: "prj_site" });
  await pg.exec(
    "update apps set latest_deployment_id = 'dpl_site1' where id = 'prj_site'",
  );
  old.workloads.prj_site = workloadInfo({
    kind: "app",
    id: "prj_site",
    slug: "site",
  });
  await db.insert(deploMoves).values({
    id: "dmv_resume",
    side: "target",
    state: "deploying",
    codeEnc: encryptSecret(MOVE_CODE),
    peerUrl: OLD,
    peerInstance: "old-instance-fingerprint",
    startedBy: "Ada",
    rowsCopied: 6,
    schedulesPaused: true,
    createdAt: T0,
    updatedAt: T0,
  });
  await db.insert(deploMoveServers).values({
    moveId: "dmv_resume",
    serverId: "srv_web",
    targetServerId: "srv_self",
    name: "web",
    position: 0,
    updatedAt: T0,
  });
  await db.insert(deploMoveWorkloads).values([
    {
      moveId: "dmv_resume",
      kind: "database",
      workloadId: "db_main",
      name: "main",
      position: 0,
      state: "done",
      updatedAt: T0,
    },
    {
      moveId: "dmv_resume",
      kind: "app",
      workloadId: "prj_site",
      name: "site",
      position: 1,
      state: "copying",
      updatedAt: T0,
    },
  ]);

  await resumeDeploMoves();
  await __waitForMoveForTest();

  assert.equal((await moveStatus("dmv_resume"))?.state, "done");
  assert.deepEqual(stepsCalled(old), ["workload:prj_site", "finish"]);
  assert.deepEqual(await workloadStates("dmv_resume"), [
    ["db_main", "done"],
    ["prj_site", "done"],
  ]);
});

test("a database error during the copy never reaches the status or the log", async () => {
  const secret = "scrypt$16384$8$1$c2VjcmV0$leaked-hash";
  __setRestorerForTest(async () => {
    throw Object.assign(
      new Error(
        `Failed query: insert into "users" select * from json_populate_recordset(null::"users", $1::json)\nparams: [{"email":"ada@old.test","password":"${secret}"}]`,
      ),
      {
        query: 'insert into "users" select * from json_populate_recordset(...)',
        params: [`[{"email":"ada@old.test","password":"${secret}"}]`],
        cause: Object.assign(new Error(`duplicate key value: ${secret}`), {
          code: "23505",
          table: "users",
          constraint: "users_email_key",
          detail: `Key (password)=(${secret}) already exists.`,
        }),
      },
    );
  });
  const [id, said] = await quietly(() => startedMove());

  const status = await moveStatus(id);
  assert.equal(status?.state, "failed");
  assert.equal(status?.error, COPY_FAILED);
  assert.ok(!said.includes(secret), said);
  assert.ok(!said.includes("ada@old.test"), said);
  assert.match(said, /code 23505, table users, constraint users_email_key/);
});

test("a database error while copying a workload is named, never quoted", async () => {
  const secret = "postgres://app:hunter2@db-main/main";
  await pg.exec(`
    create function deny_running() returns trigger language plpgsql as $$
    begin
      if new.status = 'running' then
        raise exception 'refused %', '${secret}';
      end if;
      return new;
    end $$;
    create trigger deny_running before update on databases
      for each row execute function deny_running();`);
  try {
    const [id, said] = await quietly(() => startedMove());
    const status = await moveStatus(id);
    assert.equal(status?.state, "failed");
    assert.equal(
      status?.workloads.find((w) => w.id === "db_main")?.error,
      WORKLOAD_FAILED,
    );
    assert.ok(!said.includes(secret), said);
    assert.match(said, /a database error \(code P0001/);
  } finally {
    await pg.exec(`drop trigger deny_running on databases;
      drop function deny_running();`);
  }
});

test("with the real copy engine, the old Deplo's rows land on the mapped server and this one's servers stay", async () => {
  await seedServerRow(db, {
    id: "srv_web",
    name: "web",
    ip: "198.51.100.10",
    host: "198.51.100.10",
  });
  await seedApp(db, {
    id: "prj_live",
    slug: "live",
    teamId: TEAM_A,
    serverId: "srv_web",
  });
  await pg.exec("delete from servers where id = 'srv_self'");
  const lines: string[] = [];
  for await (const line of dumpInstance()) lines.push(line);
  await pg.exec(`truncate table apps, deployments, activities cascade;
    delete from servers where id = 'srv_web';`);
  await seedServerRow(db, {
    id: "srv_self",
    name: "this-machine",
    ip: SELF_IP,
    host: SELF_IP,
  });

  old.dump = lines;
  old.workloads = {
    prj_live: workloadInfo({ kind: "app", id: "prj_live", running: false }),
  };
  __setRestorerForTest();
  const id = await startedMove();

  const status = await moveStatus(id);
  assert.equal(status?.state, "done", status?.error ?? "");
  assert.ok((status?.rowsCopied ?? 0) > 0);
  assert.deepEqual(await workloadStates(id), [["prj_live", "done"]]);
  const [app] = await db.select().from(appsTable);
  assert.equal(app.serverId, "srv_self");
  assert.deepEqual(
    (await db.select({ id: serversTable.id }).from(serversTable)).map(
      (s) => s.id,
    ),
    ["srv_self"],
    "the old Deplo's servers never come across",
  );
  assert.deepEqual(deploys, [], "never deployed there, so not here either");
});

// A copy of the old Deplo with only these rows, on the servers the map sends them to.
function restoreOnly(
  seed: (serverOf: (oldServerId: string) => string) => Promise<void>,
) {
  __setRestorerForTest(async (lines, opts) => {
    for await (const line of lines) void line;
    await pg.exec(
      "truncate table memberships, membership_capabilities, users, teams cascade",
    );
    await seedIdentity(db, {
      teams: [
        { id: "team_src1", slug: "src1" },
        { id: "team_src2", slug: "src2" },
      ],
      users: [{ id: "user_src", teamId: "team_src1", role: "owner" }],
    });
    await seed((from) => opts.serverMap.get(from)!);
    return { rows: 6, unreadable: 0 };
  });
}

const twoOldServers = (apps: number, databases: number) =>
  helloOf({
    servers: [
      summary({ id: "srv_web", name: "web", apps, databases }),
      summary({
        id: "srv_two",
        name: "two",
        address: "198.51.100.20",
        apps,
        databases,
      }),
    ],
  });

test("a second database at the same address on one server here is refused, never merged into the first", async () => {
  old.hello = twoOldServers(0, 1);
  old.workloads = {
    db_one: workloadInfo({
      kind: "database",
      id: "db_one",
      name: "main",
      slug: "db-main",
      volumes: [DB_VOLUME],
    }),
    db_two: workloadInfo({
      kind: "database",
      id: "db_two",
      name: "main",
      slug: "db-main",
      serverId: "srv_two",
      volumes: [DB_VOLUME],
    }),
  };
  restoreOnly(async (serverOf) => {
    await seedDatabase(db, {
      id: "db_one",
      teamId: "team_src1",
      serverId: serverOf("srv_web"),
      name: "main",
    });
    await seedDatabase(db, {
      id: "db_two",
      teamId: "team_src2",
      serverId: serverOf("srv_two"),
      name: "main",
    });
  });
  const id = await startedMove();

  const status = await moveStatus(id);
  assert.equal(status?.state, "failed");
  assert.deepEqual(
    status?.workloads.map((w) => [w.id, w.state, w.error]),
    [
      ["db_one", "done", ""],
      [
        "db_two",
        "failed",
        "main, from another server, already uses the database address db-main on this-machine.",
      ],
    ],
  );
  assert.deepEqual(
    agents.calls.filter((c) => c.startsWith("reroute:")),
    ["reroute:srv_self:db-main"],
  );
  assert.equal(stepsCalled(old).includes("pause:db_two"), false);
});

test("a folder or pinned volume an app from another server already brought here is refused; one shared on its old server is not", async () => {
  old.hello = twoOldServers(2, 0);
  const shared = {
    volumes: ["shared-data"],
    hostPaths: [{ path: "/srv/shared", allowFile: true }],
  };
  old.workloads = {
    prj_a: workloadInfo({ kind: "app", id: "prj_a", slug: "a", ...shared }),
    prj_b: workloadInfo({
      kind: "app",
      id: "prj_b",
      slug: "b",
      serverId: "srv_two",
      hostPaths: shared.hostPaths,
    }),
    prj_c: workloadInfo({ kind: "app", id: "prj_c", slug: "c", ...shared }),
  };
  old.data = {
    "volume:shared-data": tarGz("a.txt", "a"),
    "hostpath:/srv/shared": tarGz("b.txt", "b"),
  };
  restoreOnly(async (serverOf) => {
    for (const [id, slug, from] of [
      ["prj_a", "a", "srv_web"],
      ["prj_b", "b", "srv_two"],
      ["prj_c", "c", "srv_web"],
    ])
      await seedApp(db, {
        id,
        slug,
        teamId: "team_src1",
        serverId: serverOf(from),
      });
  });
  const id = await startedMove();

  const refused =
    "prj_a, from another server, already uses the folder /srv/shared on this-machine.";
  assert.deepEqual(
    (await moveStatus(id))?.workloads.map((w) => [w.id, w.state, w.error]),
    [
      ["prj_a", "done", ""],
      ["prj_b", "failed", refused],
      ["prj_c", "done", ""],
    ],
  );
  assert.deepEqual(
    deploys.map((d) => d.appId),
    ["prj_a", "prj_c"],
    "the refused one is never deployed onto the other's folder",
  );

  // A retry starts with nothing remembered: what holds the folder is read again from the old Deplo.
  const before = old.calls.length;
  await retryMove(id);
  await __waitForMoveForTest();
  assert.deepEqual(stepsCalled(old).slice(before), [
    "workload:prj_b",
    "workload:prj_a",
  ]);
  assert.equal(
    (await moveStatus(id))?.workloads.find((w) => w.id === "prj_b")?.error,
    refused,
  );
});

test("a migration the old Deplo was running is stopped in the copy, and nothing it held stays locked", async () => {
  const run = (id: string, status: string) => ({
    id,
    teamId: "team_src1",
    sourceUrl: "https://src.test",
    actor: "Ada",
    status,
    created: 0,
    skipped: 0,
    failed: 0,
    manual: 0,
    startedAt: T0,
    apiKeyEnc: status === "done" ? null : encryptSecret("api-key"),
  });
  afterRestore = async () => {
    await db
      .insert(migrationRuns)
      .values([
        run("mig_done", "done"),
        run("mig_queued", "queued"),
        run("mig_running", "running"),
      ]);
    await pg.exec(`update apps set migration_run_id = 'mig_running';
      update databases set migration_run_id = 'mig_running';`);
  };
  const id = await startedMove();
  assert.equal((await moveStatus(id))?.state, "done");

  const runs = await db.select().from(migrationRuns).orderBy(migrationRuns.id);
  assert.deepEqual(
    runs.map((r) => [r.id, r.status, r.error, r.apiKeyEnc === null]),
    [
      ["mig_done", "done", null, true],
      ["mig_queued", "stopped", MIGRATION_STOPPED_NOTE, true],
      ["mig_running", "stopped", MIGRATION_STOPPED_NOTE, true],
    ],
  );
  const held = [
    ...(await db.select().from(appsTable)),
    ...(await db.select().from(databasesTable)),
  ].filter((r) => r.migrationRunId !== null);
  assert.deepEqual(held, []);
});

test("an admin skips a workload that keeps failing, and the move finishes without it", async () => {
  old.fail.workload = { status: 409, error: "Not now.", id: "prj_web" };
  const id = await startedMove();
  assert.equal((await moveStatus(id))?.state, "failed");

  await assert.rejects(
    () => skipMoveWorkload(id, "app", "prj_web"),
    /Unauthorized/,
  );
  await assert.rejects(
    () => asCopiedAdmin(() => skipMoveWorkload(id, "app", "prj_site")),
    /Only an app or database that failed can be left out/,
  );
  agents.calls.length = 0;
  const skipped = await asCopiedAdmin(() =>
    skipMoveWorkload(id, "app", "prj_web"),
  );
  assert.equal(
    skipped.workloads.find((w) => w.id === "prj_web")?.state,
    "skipped",
  );
  await __waitForMoveForTest();

  const status = await moveStatus(id);
  assert.equal(status?.state, "done", status?.error ?? "");
  assert.deepEqual(
    status?.workloads.map((w) => [w.id, w.state, w.error]),
    [
      ["db_main", "done", ""],
      ["prj_site", "done", ""],
      ["prj_web", "skipped", SKIPPED_BY_HAND],
    ],
  );
  assert.equal(stepsCalled(old).at(-1), "finish");
  assert.deepEqual(agents.calls, ["stop:srv_self:web"]);
  const [web] = await db
    .select()
    .from(appsTable)
    .where(eq(appsTable.id, "prj_web"));
  assert.equal(web.status, "idle");
  const notes = await db.select().from(activities);
  assert.ok(
    notes.some(
      (a) =>
        a.teamId === "team_src1" &&
        a.actor === "user_src" &&
        a.message === `Left web out of the copy from ${OLD}`,
    ),
  );
});

test("cancelling after a retry tears down even what the retry had not reached yet", async () => {
  old.fail.pause = { status: 409, error: "Not now.", id: "prj_web" };
  const id = await startedMove();
  assert.equal(
    (await moveStatus(id))?.workloads.find((w) => w.id === "prj_web")?.state,
    "failed",
  );
  assert.ok(agents.calls.includes(`image:srv_self:${WEB_IMAGE}`));
  // Where a retry stopped before reaching them leaves them: waiting, though deployed here.
  await db
    .update(deploMoveWorkloads)
    .set({ state: "waiting", error: "" })
    .where(eq(deploMoveWorkloads.moveId, id));
  agents.calls.length = 0;

  await asCopiedAdmin(() => cancelMove(id));
  assert.deepEqual(agents.calls.sort(), [
    "destroy:srv_self:db-main",
    "destroy:srv_self:site",
    "destroy:srv_self:web",
  ]);
});

test("a refused resume fails the workload; one that never arrived leaves it to the lease", async () => {
  old.fail.resume = {
    status: 409,
    error: "This move was cancelled on the old Deplo.",
    id: "db_main",
  };
  __setMigrationFetchForTest(async (input, init) => {
    if (input.endsWith("/resume") && String(init?.body).includes("prj_web"))
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET" },
      });
    return old.fetch(input, init);
  });
  const [id] = await quietly(() => startedMove());

  assert.deepEqual(
    (await moveStatus(id))?.workloads.map((w) => [w.id, w.state, w.error]),
    [
      ["db_main", "failed", "This move was cancelled on the old Deplo."],
      ["prj_site", "done", ""],
      ["prj_web", "done", ""],
    ],
  );
  assert.equal(agents.calls.includes("start:srv_self:db-main"), false);
});

test("a volume gone from the old server fails its workload by name; folders the old server keeps are noted", async () => {
  delete old.data["volume:deplo-web_data"];
  old.workloads.prj_site = {
    ...old.workloads.prj_site,
    skippedHostPaths: ["/etc/ssl", "/var/run/docker.sock"],
  };
  const id = await startedMove();

  assert.deepEqual(
    (await moveStatus(id))?.workloads.map((w) => [w.id, w.state, w.error]),
    [
      ["db_main", "done", ""],
      [
        "prj_site",
        "done",
        "Not copied, as they are the old server's own folders: /etc/ssl, /var/run/docker.sock.",
      ],
      [
        "prj_web",
        "failed",
        "The volume deplo-web_data is not on the old server, so it could not be copied.",
      ],
    ],
  );
  assert.deepEqual([...old.paused], []);
  assert.equal(agents.calls.includes("start:srv_self:web"), false);
});

test("a published database is reached at its new server's address", async () => {
  afterRestore = async () => {
    await db
      .update(databasesTable)
      .set({
        exposedPublicly: true,
        exposedPort: 25432,
        connectionStringEnc: encryptSecret(
          "postgres://app:pw@198.51.100.10:25432/db-main",
        ),
      })
      .where(eq(databasesTable.id, "db_main"));
  };
  const id = await startedMove();
  assert.equal((await moveStatus(id))?.state, "done");
  const [main] = await db.select().from(databasesTable);
  assert.equal(
    decryptSecret(main.connectionStringEnc),
    `postgres://app:pw@${SELF_IP}:25432/db-main`,
  );
});

test("a teardown an earlier cancelled move queued never removes what this one deploys", async () => {
  const queued = (deployKey: string) => ({
    id: `tdn_${deployKey}`,
    serverId: "srv_self",
    deployKey,
    projectLabel: deployKey,
    label: deployKey,
    teamId: null,
    attempts: 1,
    lastError: "",
    nextAttemptAt: T0,
    createdAt: T0,
  });
  // After the copy lands: the stub copy empties every table that names a team.
  afterRestore = async () => {
    await db
      .insert(pendingTeardowns)
      .values([queued("db-main"), queued("web"), queued("other")]);
  };
  const id = await startedMove();
  assert.equal((await moveStatus(id))?.state, "done");
  assert.deepEqual(
    (await db.select().from(pendingTeardowns)).map((t) => t.deployKey),
    ["other"],
  );
});
