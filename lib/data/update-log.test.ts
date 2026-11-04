import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { deploUpdateLog } from "../db/schema/control-plane/instance";
import { runWithIdentity } from "../auth/request-context";
import { captureFetch } from "../notify/fetch-capture-test-helpers";
import { __setAgentConnectorForTest } from "../infra/agent-client/connect";
import { CONTROL_PLANE_UPDATE_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import { DEPLO_VERSION, versionTag } from "../version";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import {
  __resetThisReleaseForTest,
  __setThisReleaseForTest,
} from "./update-stops/decision";
import { applyDeploUpdate, getUpdateInfo } from "./updates";
import {
  effectiveEntry,
  listUpdateLog,
  settleUpdateLogAtBoot,
  sweepUpdateLog,
  UNFINISHED_AFTER_MS,
} from "./update-log";

let db: TestDb;
let pg: PGlite;
let dataDir: string;
let prevDataDir: string | undefined;

const ADMIN = "admin1";
const MEMBER = "member2";
const HOST_IP = "192.0.2.78";
const HERE = versionTag(DEPLO_VERSION);

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  prevDataDir = process.env.DEPLO_DATA_DIR;
  dataDir = await mkdtemp(join(tmpdir(), "deplo-update-log-"));
  process.env.DEPLO_DATA_DIR = dataDir;
});

after(async () => {
  __resetThisReleaseForTest();
  __setAgentConnectorForTest();
  __resetTestDb();
  await pg.close();
  await rm(dataDir, { recursive: true, force: true });
  if (prevDataDir === undefined) delete process.env.DEPLO_DATA_DIR;
  else process.env.DEPLO_DATA_DIR = prevDataDir;
});

beforeEach(async () => {
  __setThisReleaseForTest({ updateStop: false });
  await rm(join(dataDir, "refused-update"), { force: true });
  await pg.exec(
    `${TRUNCATE_IDENTITY} truncate table deplo_update_log, passed_update_stops, servers restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: ADMIN, teamId: TEAM_A }, fn);

const rows = () => db.select().from(deploUpdateLog);

function github(declares: Record<string, unknown> = {}) {
  return captureFetch((url) => {
    if (url.includes("raw.githubusercontent.com"))
      return Response.json({ deplo: { agentMin: "0.4.0", ...declares } });
    return Response.json({ tag_name: "v99.0.0", html_url: "latest" });
  });
}

async function onDeploHost(
  update: () => Promise<{ ok: boolean; logPath: string; error: string }>,
): Promise<() => void> {
  const prevIp = process.env.DEPLO_SERVER_IP;
  process.env.DEPLO_SERVER_IP = HOST_IP;
  await seedServerRow(db, { id: "srv_host", name: "host", ip: HOST_IP });
  __setAgentConnectorForTest(
    async () =>
      ({
        hello: async () => ({
          capabilities: [CONTROL_PLANE_UPDATE_CAPABILITY],
        }),
        updateControlPlane: update,
        close: () => {},
      }) as unknown as Awaited<
        ReturnType<typeof import("../infra/agent-client/connect").openAgent>
      >,
  );
  return () => {
    __setAgentConnectorForTest();
    if (prevIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = prevIp;
  };
}

async function refusedNote(version: string, at: string) {
  await writeFile(
    join(dataDir, "refused-update"),
    `version=${version}\nreason=The new version did not start.\nat=${at}\n`,
  );
}

test("the Update button opens a row naming who clicked it and where the run is written", async () => {
  const capture = github();
  const restore = await onDeploHost(async () => ({
    ok: true,
    logPath: "/var/log/deplo-update.log",
    error: "",
  }));
  try {
    await asAdmin(applyDeploUpdate);
    const [row] = await rows();
    assert.equal(row.trigger, "button");
    assert.equal(row.outcome, "running");
    assert.equal(row.fromVersion, HERE);
    assert.equal(row.toVersion, "v99.0.0");
    assert.ok(row.actor);
    assert.equal(row.logPath, "/var/log/deplo-update.log");
  } finally {
    restore();
    capture.restore();
  }
});

test("an update the host refuses to start is logged as failed, with the host's reason", async () => {
  const capture = github();
  const restore = await onDeploHost(async () => ({
    ok: false,
    logPath: "",
    error: "The disk is full.",
  }));
  try {
    await assert.rejects(asAdmin(applyDeploUpdate), /The disk is full/);
    const [row] = await rows();
    assert.equal(row.outcome, "failed");
    assert.equal(row.reason, "The disk is full.");
    assert.ok(row.finishedAt);
  } finally {
    restore();
    capture.restore();
  }
});

test("booting on the version an open row aimed at closes it as updated", async () => {
  await db.insert(deploUpdateLog).values({
    id: "dupd_a",
    trigger: "button",
    outcome: "running",
    fromVersion: "v0.0.1",
    toVersion: HERE,
    actor: "Alice",
    at: new Date().toISOString(),
  });
  await settleUpdateLogAtBoot("0.0.1");
  const all = await rows();
  assert.equal(all.length, 1, "no second row for the same update");
  assert.equal(all[0].outcome, "updated");
  assert.ok(all[0].finishedAt);
});

test("booting back on the old version after a rollback closes the row with the installer's reason", async () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  await db.insert(deploUpdateLog).values({
    id: "dupd_b",
    trigger: "automatic",
    outcome: "running",
    fromVersion: HERE,
    toVersion: "v99.0.0",
    at,
  });
  await refusedNote("99.0.0", new Date().toISOString());
  await settleUpdateLogAtBoot(DEPLO_VERSION);
  const [row] = await rows();
  assert.equal(row.outcome, "rolled_back");
  assert.equal(row.reason, "The new version did not start.");
});

test("an update the installer ran by itself is logged once, from the host", async () => {
  await settleUpdateLogAtBoot("0.0.1");
  const [row] = await rows();
  assert.equal(row.trigger, "host");
  assert.equal(row.outcome, "updated");
  assert.equal(row.fromVersion, "v0.0.1");
  assert.equal(row.toVersion, HERE);
  await settleUpdateLogAtBoot(DEPLO_VERSION);
  assert.equal((await rows()).length, 1, "an ordinary restart adds nothing");
});

test("a rollback the installer ran by itself is logged once, however often Deplo restarts", async () => {
  await refusedNote("99.0.0", "2026-11-04T02:00:00Z");
  await settleUpdateLogAtBoot(DEPLO_VERSION);
  await settleUpdateLogAtBoot(DEPLO_VERSION);
  const all = await rows();
  assert.equal(all.length, 1);
  assert.equal(all[0].trigger, "host");
  assert.equal(all[0].outcome, "rolled_back");
  assert.equal(all[0].toVersion, "v99.0.0");
});

test("a row still open long after it started reads as failed, naming the run's log", () => {
  const at = "2026-11-04T02:00:00.000Z";
  const row = {
    id: "dupd_c",
    trigger: "automatic",
    outcome: "running",
    fromVersion: "v0.8.0",
    toVersion: "v0.9.0",
    actor: null,
    reason: null,
    logPath: "/var/log/deplo-update.log",
    at,
    finishedAt: null,
  };
  const soon = Date.parse(at) + 60_000;
  assert.equal(effectiveEntry(row, soon).outcome, "running");
  const late = effectiveEntry(row, Date.parse(at) + UNFINISHED_AFTER_MS);
  assert.equal(late.outcome, "failed");
  assert.match(late.reason ?? "", /\/var\/log\/deplo-update\.log/);
});

test("entries older than 90 days are swept", async () => {
  const now = new Date("2026-11-04T00:00:00Z");
  const base = {
    trigger: "button",
    outcome: "updated",
    fromVersion: "v0.1.0",
    toVersion: "v0.2.0",
  };
  await db.insert(deploUpdateLog).values([
    { ...base, id: "dupd_old", at: "2026-07-01T00:00:00.000Z" },
    { ...base, id: "dupd_new", at: "2026-10-01T00:00:00.000Z" },
  ]);
  await sweepUpdateLog(now);
  assert.deepEqual(
    (await rows()).map((r) => r.id),
    ["dupd_new"],
  );
});

test("only an instance admin reads the log", async () => {
  await assert.rejects(
    runWithIdentity({ userId: MEMBER, teamId: TEAM_A }, listUpdateLog),
  );
  assert.deepEqual(await asAdmin(listUpdateLog), []);
});

test("a release that declares a manual step says so on the update it would install", async () => {
  const capture = github({ manualUpdate: "  Read the notes first.  " });
  try {
    const info = await asAdmin(getUpdateInfo);
    assert.equal(info.next, "v99.0.0");
    assert.equal(info.manualUpdate, "Read the notes first.");
  } finally {
    capture.restore();
  }
});
