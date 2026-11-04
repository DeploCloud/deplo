import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  deploUpdateLog,
  instanceSettings,
} from "../db/schema/control-plane/instance";
import { dockerCleanupRuns } from "../db/schema/control-plane/docker-cleanup";
import {
  captureFetch,
  type FetchCapture,
} from "../notify/fetch-capture-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { CONTROL_PLANE_UPDATE_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { __resetLocalLeases } from "../backups/lease";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "../data/identity-test-helpers";
import { seedServerRow } from "../data/infra-test-helpers";
import { seedApp, seedDeployment } from "../data/app-graph-test-helpers";
import {
  __resetThisReleaseForTest,
  __setThisReleaseForTest,
} from "../data/update-stops/decision";
import { __resetHostTimezoneForTest } from "../data/auto-updates";
import { SETTINGS_ID } from "../data/instance-settings/settings-store";
import { runAutoUpdateTick, workInProgress } from "./scheduler";

let db: TestDb;
let pg: PGlite;
let capture: FetchCapture;
let installed: string[];
const env: Record<string, string | undefined> = {};

const HOST_IP = "192.0.2.79";
const NIGHT = new Date("2026-11-05T02:10:00Z");

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  for (const k of ["DEPLO_SERVER_IP", "DEPLO_AUTO_UPDATE"])
    env[k] = process.env[k];
});

after(async () => {
  __resetThisReleaseForTest();
  __setAgentConnectorForTest();
  __resetHostTimezoneForTest();
  __resetTestDb();
  await pg.close();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

beforeEach(async () => {
  __setThisReleaseForTest({ updateStop: false });
  __resetLocalLeases();
  __resetHostTimezoneForTest(null);
  process.env.DEPLO_SERVER_IP = HOST_IP;
  delete process.env.DEPLO_AUTO_UPDATE;
  await pg.exec(
    `${TRUNCATE_IDENTITY} truncate table deplo_update_log, docker_cleanup_runs, instance_settings, passed_update_stops, servers restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: "admin1", teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
    ],
  });
  await seedServerRow(db, { id: "srv_host", name: "host", ip: HOST_IP });
  installed = [];
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({
          capabilities: [CONTROL_PLANE_UPDATE_CAPABILITY],
        }),
        updateControlPlane: async (req: { version: string }) => {
          installed.push(req.version);
          return { ok: true, logPath: "/var/log/deplo-update.log", error: "" };
        },
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client/connect").openAgent>
      >,
  );
  capture?.restore();
  capture = github({ publishedAt: "2026-11-03T10:00:00Z" });
});

function github(release: { publishedAt: string; declares?: object }) {
  return captureFetch((url) => {
    if (url.includes("raw.githubusercontent.com"))
      return Response.json({
        deplo: { agentMin: "0.4.0", ...release.declares },
      });
    return Response.json({
      tag_name: "v99.0.0",
      html_url: "latest",
      published_at: release.publishedAt,
    });
  });
}

const log = () => db.select().from(deploUpdateLog);

test("at night, with nothing running, Deplo installs the matured release itself", async () => {
  const step = await runAutoUpdateTick(NIGHT);
  assert.deepEqual(step, { kind: "install", version: "v99.0.0" });
  assert.deepEqual(installed, ["99.0.0"]);
  const [row] = await log();
  assert.equal(row.trigger, "automatic");
  assert.equal(row.actor, null);
  assert.equal(row.outcome, "running");
  // Written on the real clock; the ticks here run on the test's.
  await db.update(deploUpdateLog).set({ at: NIGHT.toISOString() });
  // The next tick in the same slot leaves it alone.
  assert.deepEqual(await runAutoUpdateTick(new Date("2026-11-05T02:15:00Z")), {
    kind: "wait",
  });
  assert.equal(installed.length, 1);
});

test("a cleanup under way skips the slot, and the log says why", async () => {
  await db.insert(dockerCleanupRuns).values({
    id: "clr_1",
    serverName: "host",
    trigger: "manual",
    actor: "Alice",
    status: "running",
    reclaimedBytes: 0,
    startedAt: NIGHT.toISOString(),
  });
  const step = await runAutoUpdateTick(NIGHT);
  assert.equal(step?.kind, "skip");
  assert.deepEqual(installed, []);
  const [row] = await log();
  assert.equal(row.outcome, "skipped");
  assert.equal(
    row.reason,
    "A server cleanup was running. Deplo tries again at 03:00.",
  );
});

test("a deploy that is building counts as work in progress; a queued one does not", async () => {
  await seedServerRow(db, { id: "srv_1", name: "one", ip: "192.0.2.80" });
  await seedApp(db, { id: "prj_web" });
  await seedDeployment(db, { id: "dpl_q", appId: "prj_web", status: "queued" });
  assert.equal(await workInProgress(), null);
  await seedDeployment(db, {
    id: "dpl_b",
    appId: "prj_web",
    status: "building",
  });
  assert.equal(await workInProgress(), "A deploy was running");
});

test("switched off, on a canary, or locked by the install, nothing is installed", async () => {
  const settle = async (
    patch: Partial<typeof instanceSettings.$inferInsert>,
  ) => {
    await pg.exec("truncate table instance_settings, deplo_update_log;");
    await db
      .insert(instanceSettings)
      .values({ id: SETTINGS_ID, updatedAt: NIGHT.toISOString(), ...patch });
    return runAutoUpdateTick(NIGHT);
  };
  assert.deepEqual(await settle({ autoUpdatesEnabled: false }), {
    kind: "wait",
  });
  assert.deepEqual(await settle({ canaryReleases: true }), { kind: "wait" });
  process.env.DEPLO_AUTO_UPDATE = "off";
  assert.deepEqual(await settle({}), { kind: "wait" });
  assert.deepEqual(installed, []);
});

test("a release under a day old waits; the same release fixing a flaw does not", async () => {
  capture.restore();
  capture = github({ publishedAt: "2026-11-05T00:00:00Z" });
  assert.deepEqual(await runAutoUpdateTick(NIGHT), { kind: "wait" });
  capture.restore();
  capture = github({
    publishedAt: "2026-11-05T00:00:00Z",
    declares: { securityFloor: "99.0.0" },
  });
  assert.equal((await runAutoUpdateTick(NIGHT))?.kind, "install");
});

test("a release with a manual step is held, logged once and announced once", async () => {
  capture.restore();
  capture = github({
    publishedAt: "2026-11-03T10:00:00Z",
    declares: { manualUpdate: "Move your backups first." },
  });
  assert.equal((await runAutoUpdateTick(NIGHT))?.kind, "hold");
  await runAutoUpdateTick(new Date("2026-11-05T03:10:00Z"));
  const rows = await log();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "held");
  assert.equal(rows[0].reason, "Move your backups first.");
  assert.ok(rows[0].notifiedAt, "announced");
  assert.deepEqual(installed, []);
});

test("the update that came back is announced once, after the restart", async () => {
  await db.insert(deploUpdateLog).values({
    id: "dupd_done",
    trigger: "automatic",
    outcome: "updated",
    fromVersion: "v0.9.0",
    toVersion: "v0.9.1",
    at: "2026-11-05T02:00:00.000Z",
    finishedAt: "2026-11-05T02:01:00.000Z",
  });
  await runAutoUpdateTick(new Date("2026-11-05T12:00:00Z"));
  const [row] = (await log()).filter((r) => r.id === "dupd_done");
  assert.ok(row.notifiedAt);
});
