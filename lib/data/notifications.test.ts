import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { notificationSettings } from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { defaultNotificationSettings, type NotificationSettings } from "../types";
import { seedIdentity, TEAM_A, USER_1 } from "./leaf-test-helpers";
import {
  getNotificationSettings,
  updateNotificationSettings,
} from "./notifications";

/**
 * Data-layer tests for `notification_settings` against pglite (PLAN Step 2). The
 * collection is a `Record<teamId, …>` map → one row per team; an absent row reads
 * back as `defaultNotificationSettings()`. `updateNotificationSettings` upserts on
 * the `team_id` PK so a second save overwrites rather than duplicating.
 */

let db: TestDb;
let pg: PGlite;

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
    `truncate table notification_settings, users, teams restart identity cascade;`,
  );
  await seedIdentity(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

function customSettings(): NotificationSettings {
  const s = defaultNotificationSettings();
  return {
    channels: {
      push: { enabled: true },
      email: { enabled: true, address: "alerts@alpha.io" },
      discord: { enabled: true, webhookUrl: "https://discord/hook" },
      webhook: { enabled: false, url: "" },
    },
    events: { ...s.events, deployment_succeeded: true, update_available: false },
  };
}

test("getNotificationSettings returns the default when the team has no row", async () => {
  await asUser1(async () => {
    assert.deepEqual(await getNotificationSettings(), defaultNotificationSettings());
  });
  assert.equal((await db.select().from(notificationSettings)).length, 0);
});

test("update then get round-trips every channel and event", async () => {
  const next = customSettings();
  await asUser1(async () => {
    const returned = await updateNotificationSettings(next);
    assert.deepEqual(returned, next);
    assert.deepEqual(await getNotificationSettings(), next);
  });
});

test("a second update overwrites the same row (upsert, no duplicate)", async () => {
  await asUser1(async () => {
    await updateNotificationSettings(customSettings());
    const changed = customSettings();
    changed.channels.email.address = "changed@alpha.io";
    await updateNotificationSettings(changed);
    const got = await getNotificationSettings();
    assert.equal(got.channels.email.address, "changed@alpha.io");
  });
  // Exactly one row for the team (team_id PK).
  assert.equal((await db.select().from(notificationSettings)).length, 1);
});
