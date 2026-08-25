import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "../data/leaf-test-helpers";
import { saveNotificationChannel } from "../data/notifications";
import { captureFetch, type FetchCapture } from "./fetch-capture-test-helpers";
import { __resetCooldowns } from "./cooldown";
import { noteFailedLogin } from "./security";

/**
 * The failed-sign-in alert, driven the way an attacker drives it: through a PUBLIC
 * mutation, with an address of their choosing. The rule this file exists to hold
 * is the one the alert broke: an address that matches no account tells NOBODY.
 */

let db: TestDb;
let pg: PGlite;
let capture: FetchCapture | null = null;

const USER_2 = "user_2";
/**
 * `rateLimit`'s buckets are process-global and outlive one test, so every case
 * here counts against an address of its own — sharing one would make the second
 * assertion depend on the first having run.
 */
const USER_3 = "user_3";
/** `noteFailedLogin` is fire-and-forget, so the assertions wait a tick. */
const settle = () => new Promise((r) => setTimeout(r, 30));

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    `truncate table notification_alerts, notification_channels, users, teams restart identity cascade;`,
  );
  // TEAM_A is the OLDEST team — the one the old fallback would have picked.
  await seedIdentity(db, {
    users: [
      { id: USER_1, teamId: TEAM_A, role: "owner" },
      { id: USER_2, teamId: TEAM_B, role: "owner" },
      { id: USER_3, teamId: TEAM_A, role: "owner" },
    ],
  });
  await runWithIdentity({ userId: USER_1, teamId: TEAM_A }, () =>
    saveNotificationChannel(null, {
      kind: "discord",
      name: "",
      enabled: true,
      url: "https://discord/hook",
      target: "",
      emailFrom: "",
      emailProvider: "resend",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      alerts: ["failed_logins"],
    }),
  );
  __resetCooldowns();
  capture = captureFetch();
});

afterEach(() => {
  capture?.restore();
  capture = null;
});

/** One burst: the limit plus the attempt that refuses. */
function burst(subject: string) {
  for (let i = 0; i < 6; i++) noteFailedLogin(subject);
}

test("an address that matches no account alerts nobody", async () => {
  burst("nobody@example.com");
  await settle();
  assert.deepEqual(
    capture!.calls,
    [],
    "an unauthenticated stranger must not reach a tenant's channels",
  );
});

test("a burst against a real account reaches that account's team", async () => {
  burst("user_1@example.io");
  await settle();
  assert.equal(capture!.calls.length, 1);
  assert.match(
    JSON.stringify(capture!.calls[0].body),
    /Repeated failed sign-in attempts/,
  );
});

test("a burst under the limit says nothing at all", async () => {
  for (let i = 0; i < 5; i++) noteFailedLogin("user_3@example.io");
  await settle();
  assert.deepEqual(capture!.calls, []);
});

test("the burst reaches the account's own team, not the oldest one", async () => {
  // USER_2 is in TEAM_B, which has no channel. TEAM_A has one and is older, so
  // a fallback to "the first team" would show up here as a call.
  burst("user_2@example.io");
  await settle();
  assert.deepEqual(capture!.calls, []);
});
