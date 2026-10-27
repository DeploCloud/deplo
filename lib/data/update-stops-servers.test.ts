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
import {
  seedIdentity,
  TRUNCATE_IDENTITY,
  TEAM_A,
} from "./identity-test-helpers";
import { seedServerRow } from "./infra-test-helpers";
import { recordFirstLink } from "./servers/agent-handshake";
import { removeServer } from "./servers/removal";
import {
  __resetThisReleaseForTest,
  __setThisReleaseForTest,
} from "./update-stops/decision";
import { getUpdateInfo } from "./updates";

let db: TestDb;
let pg: PGlite;

const ADMIN = "admin1";
const NEWER = "99.1.0";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetThisReleaseForTest();
  __resetTestDb();
  await pg.close();
});

let github: FetchCapture;

beforeEach(async () => {
  // This release is the first stop, judged by its real condition: the servers.
  __setThisReleaseForTest({ updateStop: true });
  await pg.exec(
    `${TRUNCATE_IDENTITY} truncate table passed_update_stops, servers restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: ADMIN, teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
    ],
  });
  github?.restore();
  github = newerReleaseRequiresThisOne();
});

after(() => github?.restore());

const asAdmin = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: ADMIN, teamId: TEAM_A }, fn);

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
    ip: `10.0.9.${++n}`,
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
  await seedServerRow(db, { id: "never-installed", ip: "10.0.9.200" });

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
