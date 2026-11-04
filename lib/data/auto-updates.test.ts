import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { deploUpdateLog } from "../db/schema/control-plane/instance";
import { activities } from "../db/schema/control-plane/activity";
import { runWithIdentity } from "../auth/request-context";
import {
  captureFetch,
  type FetchCapture,
} from "../notify/fetch-capture-test-helpers";
import { deploUpdateAlert } from "../notify/maintenance";
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
import {
  __resetHostTimezoneForTest,
  adoptAutoUpdateTimezone,
  postponeAutoUpdate,
  readAutoUpdateSettings,
  readAutoUpdateStatus,
  setAutoUpdates,
} from "./auto-updates";
import { getUpdateInfo } from "./updates";

let db: TestDb;
let pg: PGlite;
let capture: FetchCapture;
const env: Record<string, string | undefined> = {};
const HOST_IP = "192.0.2.81";

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
  for (const k of ["DEPLO_SERVER_IP", "DEPLO_AUTO_UPDATE"])
    env[k] = process.env[k];
  capture = captureFetch((url) =>
    url.includes("raw.githubusercontent.com")
      ? Response.json({ deplo: { agentMin: "0.4.0" } })
      : Response.json({
          tag_name: "v99.0.0",
          html_url: "latest",
          published_at: "2026-01-01T00:00:00Z",
        }),
  );
});

after(async () => {
  capture.restore();
  __resetThisReleaseForTest();
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
  __resetHostTimezoneForTest(null);
  process.env.DEPLO_SERVER_IP = HOST_IP;
  delete process.env.DEPLO_AUTO_UPDATE;
  await pg.exec(
    `${TRUNCATE_IDENTITY} truncate table deplo_update_log, instance_settings, passed_update_stops, servers restart identity cascade;`,
  );
  await seedIdentity(db, {
    users: [
      { id: "admin1", teamId: TEAM_A, role: "owner", isInstanceAdmin: true },
      { id: "member2", teamId: TEAM_A, role: "member", isInstanceAdmin: false },
    ],
  });
  await seedServerRow(db, { id: "srv_host", name: "host", ip: HOST_IP });
});

const asAdmin = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: "admin1", teamId: TEAM_A }, fn);
const asMember = <T>(fn: () => Promise<T>) =>
  runWithIdentity({ userId: "member2", teamId: TEAM_A }, fn);

test("on by default, at 02:00, on the machine's clock", async () => {
  const s = await asAdmin(() => readAutoUpdateStatus());
  assert.equal(s.enabled, true);
  assert.equal(s.blockedBy, null);
  assert.equal(s.hour, 2);
  assert.equal(s.timezone, "UTC");
  assert.equal(s.timezoneSource, "default");
  assert.ok(s.installsAt, "a matured release waits for the night");
});

test("only an instance admin reads or changes it", async () => {
  await assert.rejects(asMember(() => readAutoUpdateStatus()));
  await assert.rejects(asMember(() => setAutoUpdates({ enabled: false })));
  await assert.rejects(asMember(() => postponeAutoUpdate()));
  await assert.rejects(asMember(() => adoptAutoUpdateTimezone("Europe/Rome")));
  assert.equal((await readAutoUpdateSettings()).enabled, true);
});

test("switching it off is recorded; a bad hour or zone is refused", async () => {
  await asAdmin(() => setAutoUpdates({ enabled: false }));
  assert.equal((await readAutoUpdateSettings()).enabled, false);
  const acts = await db.select().from(activities);
  assert.ok(
    acts.some((a) => a.message === "Turned off automatic updates of Deplo"),
  );
  await assert.rejects(
    asAdmin(() => setAutoUpdates({ hour: 24 })),
    /00:00 to 23:00/,
  );
  await assert.rejects(
    asAdmin(() => setAutoUpdates({ timezone: "Mars/Olympus" })),
    /not a timezone/,
  );
  await asAdmin(() => setAutoUpdates({ hour: 3, timezone: "US/Eastern" }));
  const s = await readAutoUpdateSettings();
  assert.equal(s.hour, 3);
  assert.equal(s.timezone, "America/New_York");
  await asAdmin(() => setAutoUpdates({ timezone: "" }));
  assert.equal((await readAutoUpdateSettings()).timezone, null);
});

test("postponing skips one night at a time, and the log keeps who did it", async () => {
  await asAdmin(() => postponeAutoUpdate());
  const first = (await readAutoUpdateSettings()).postponedUntil;
  assert.ok(first && Date.parse(first) > Date.now());
  await asAdmin(() => postponeAutoUpdate());
  const second = (await readAutoUpdateSettings()).postponedUntil!;
  assert.equal(Date.parse(second) - Date.parse(first), 24 * 3_600_000);
  const rows = await db.select().from(deploUpdateLog);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.outcome === "postponed" && r.actor));
  const s = await asAdmin(() => readAutoUpdateStatus());
  assert.equal(s.postponedTimes, 2);
  assert.ok(s.postponedBy);
  assert.ok(Date.parse(s.installsAt!) >= Date.parse(second));
});

test("the admin's browser names the zone only while the machine says UTC", async () => {
  await asAdmin(() => adoptAutoUpdateTimezone("Europe/Rome"));
  assert.equal((await readAutoUpdateSettings()).timezone, "Europe/Rome");
  await asAdmin(() => adoptAutoUpdateTimezone("Asia/Tokyo"));
  assert.equal(
    (await readAutoUpdateSettings()).timezone,
    "Europe/Rome",
    "never overwrites",
  );

  await pg.exec("truncate table instance_settings;");
  __resetHostTimezoneForTest("America/Chicago");
  await asAdmin(() => adoptAutoUpdateTimezone("Europe/Rome"));
  assert.equal((await readAutoUpdateSettings()).timezone, null);
  const s = await asAdmin(() => readAutoUpdateStatus());
  assert.equal(s.timezone, "America/Chicago");
  assert.equal(s.timezoneSource, "server");
});

test("paused, not forgotten, by the install's own switch or a missing host server", async () => {
  process.env.DEPLO_AUTO_UPDATE = "off";
  assert.equal(
    (await asAdmin(() => readAutoUpdateStatus())).blockedBy,
    "provider",
  );
  delete process.env.DEPLO_AUTO_UPDATE;
  delete process.env.DEPLO_SERVER_IP;
  await pg.exec("truncate table servers cascade;");
  const s = await asAdmin(() => readAutoUpdateStatus());
  assert.equal(s.blockedBy, "host");
  assert.equal(s.enabled, true);
  assert.equal(s.installsAt, null);
});

test("an update that installs itself is not announced beforehand; a security fix still is", async () => {
  const info = await getUpdateInfo();
  assert.ok(deploUpdateAlert(info, false));
  assert.equal(deploUpdateAlert(info, true), null);
  assert.equal(
    deploUpdateAlert({ ...info, securityFix: "v99.0.0" }, true)?.key,
    "deplo_security_fix",
  );
});
