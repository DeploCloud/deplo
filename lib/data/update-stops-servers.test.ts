import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  captureFetch,
  type FetchCapture,
} from "../notify/fetch-capture-test-helpers";
import { DEPLO_VERSION } from "../version";
import type { Server } from "../types/server";
import { listActivity } from "./activity";
import { TRUNCATE_PROJECT_GRAPH, seedApp } from "./app-graph-test-helpers";
import { getAppById } from "./apps/listing";
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { recordFirstLink } from "./servers/agent-handshake";
import { removeServer } from "./servers/removal";
import { getServerById } from "./servers/roster";
import {
  __resetThisReleaseForTest,
  __setThisReleaseForTest,
} from "./update-stops/decision";
import { leaveServerBehind } from "./update-stops/leave-behind";
import { getUpdateInfo } from "./updates";

let db: TestDb;
let pg: PGlite;
let github: FetchCapture | undefined;

const ADMIN = "admin1";
const MEMBER = "member2";
const HOST_IP = "192.0.2.77";
const NEWER = "99.1.0";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  github?.restore();
  __resetThisReleaseForTest();
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  // This release is the first stop, judged by its real condition: the servers.
  __setThisReleaseForTest({ updateStop: true });
  await pg.exec(
    `${TRUNCATE_IDENTITY} ${TRUNCATE_PROJECT_GRAPH} truncate table passed_update_stops, activities restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: MEMBER, teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  github?.restore();
  github = newerReleaseRequiresThisOne();
});

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: ADMIN, teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: MEMBER, teamId: TEAM_A }, fn);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// GitHub's newest stable is a release that has to come after this one.
function newerReleaseRequiresThisOne(): FetchCapture {
  return captureFetch((url) => {
    if (/raw\.githubusercontent\.com\/.+\/v99\.1\.0\/package\.json$/.test(url))
      return json({ deplo: { requiresStop: DEPLO_VERSION } });
    if (url.includes("raw.githubusercontent.com")) return json({});
    if (url.includes("/releases/latest"))
      return json({ tag_name: `v${NEWER}`, html_url: "latest" });
    return json([{ tag_name: `v${NEWER}` }]);
  });
}

let n = 0;
const enrolled = (id: string, over: Partial<Server> = {}) =>
  seedServerRow(db, {
    id,
    name: id,
    ip: `198.51.100.${++n}`,
    host: `198.51.100.${n}`,
    agent: {
      port: 9443,
      certFingerprint: `fp_${id}`,
      certPem: "pem",
      version: "0.5.0",
    },
    ...over,
  });

const names = (servers: { name: string }[] | undefined) =>
  (servers ?? []).map((s) => s.name);

test("on the stop, Update names each server still waiting to connect, and offers nothing past it", async () => {
  await enrolled("linked", { firstLinkedAt: "2026-10-20T00:00:00.000Z" });
  await enrolled("edge-1");
  await enrolled("migration-source", { importOnly: true });
  await seedServerRow(db, {
    id: "never-installed",
    ip: "198.51.100.200",
    host: "198.51.100.200",
  });

  const info = await asAdmin(getUpdateInfo);
  assert.equal(info.next, null);
  assert.equal(info.updateAvailable, false);
  assert.equal(info.stop?.waiting, true);
  assert.deepEqual(names(info.stop?.waitingOn), ["edge-1"]);
});

test("the release past the stop is offered the moment the last server connects", async () => {
  await enrolled("edge-1");
  assert.equal((await asAdmin(getUpdateInfo)).next, null);

  await recordFirstLink("edge-1");
  // Enrolled after the pass: it cannot take back a stop already passed at that first link.
  await enrolled("edge-2");

  const info = await asAdmin(getUpdateInfo);
  assert.equal(info.next, `v${NEWER}`);
  assert.equal(info.stop, null);
});

test("a removed server drops off the list, and removing the last one passes the stop", async () => {
  await enrolled("edge-1");
  await enrolled("edge-2");

  await asAdmin(() => removeServer("edge-1"));
  assert.deepEqual(names((await asAdmin(getUpdateInfo)).stop?.waitingOn), [
    "edge-2",
  ]);

  await asAdmin(() => removeServer("edge-2"));
  await enrolled("edge-3");
  assert.equal((await asAdmin(getUpdateInfo)).next, `v${NEWER}`);
});

test("an instance admin leaves a server behind: the stop passes, and the server keeps its apps and settings", async () => {
  await enrolled("edge-1", { buildOnly: true });
  await seedApp(db, { id: "app_web", serverId: "edge-1" });

  const info = await asAdmin(() => leaveServerBehind("edge-1"));
  assert.equal(info.next, `v${NEWER}`, "offered at once, nothing to click");

  const server = await getServerById("edge-1");
  assert.equal(server?.name, "edge-1");
  assert.equal(server?.buildOnly, true);
  assert.equal(
    (await asAdmin(() => getAppById("app_web")))?.serverId,
    "edge-1",
  );
  const [entry] = await asAdmin(() => listActivity(5, { types: ["server"] }));
  assert.equal(
    entry?.message,
    "Left server edge-1 behind, so Deplo can update without it",
  );
});

test("a server left behind is named apart from the ones still waiting", async () => {
  await enrolled("edge-1");
  await enrolled("edge-2");

  const info = await asAdmin(() => leaveServerBehind("edge-1"));
  assert.equal(info.next, null);
  assert.deepEqual(names(info.stop?.waitingOn), ["edge-2"]);
  assert.deepEqual(names(info.stop?.leftBehind), ["edge-1"]);
});

test("the machine Deplo runs on is never left behind", async () => {
  const prevIp = process.env.DEPLO_SERVER_IP;
  process.env.DEPLO_SERVER_IP = HOST_IP;
  try {
    await enrolled("host", { ip: HOST_IP, host: HOST_IP });
    await assert.rejects(
      () => asAdmin(() => leaveServerBehind("host")),
      /host is the machine Deplo runs on, so it can't be left behind/,
    );
    assert.deepEqual(names((await asAdmin(getUpdateInfo)).stop?.waitingOn), [
      "host",
    ]);
  } finally {
    if (prevIp === undefined) delete process.env.DEPLO_SERVER_IP;
    else process.env.DEPLO_SERVER_IP = prevIp;
  }
});

test("only an instance admin leaves a server behind, and only one that has not connected", async () => {
  await enrolled("edge-1");
  await enrolled("linked", { firstLinkedAt: "2026-10-20T00:00:00.000Z" });

  await assert.rejects(() => asMember(() => leaveServerBehind("edge-1")));
  await assert.rejects(
    () => asAdmin(() => leaveServerBehind("linked")),
    /linked has already connected to Deplo/,
  );
  assert.deepEqual(names((await asAdmin(getUpdateInfo)).stop?.waitingOn), [
    "edge-1",
  ]);
});
