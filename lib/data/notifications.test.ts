import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";
import { and, eq } from "drizzle-orm";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import {
  notificationAlerts,
  notificationSettings,
} from "../db/schema/control-plane";
import { runWithIdentity } from "../auth/request-context";
import { defaultNotificationSettings, DEFAULT_ALERTS } from "../alerts";
import { ALL_ALERTS, type NotificationSettingsInput } from "../types";
import { seedIdentity, TEAM_A, USER_1 } from "./leaf-test-helpers";
import {
  alertConfigForTeam,
  getNotificationSettings,
  parseSettingsInput,
  updateNotificationSettings,
} from "./notifications";

/**
 * Data-layer tests for the notification settings against pglite.
 *
 * Two halves with different storage rules and both are pinned here: the CHANNELS
 * are flat columns on one row per team (`team_id` PK, upsert), and the subscribed
 * ALERTS are rows in `notification_alerts` where an ABSENT row means "never
 * decided" and falls back to the catalog default. That fallback is the contract
 * that lets a new alert key ship without a backfill, so it has its own test.
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
    `truncate table notification_alerts, notification_settings, users, teams restart identity cascade;`,
  );
  await seedIdentity(db);
});

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

function customSettings(): NotificationSettingsInput {
  return {
    channels: {
      push: { enabled: true },
      email: {
        enabled: true,
        address: "alerts@alpha.io",
        from: "deplo@alpha.io",
        provider: "smtp",
        // The bits are recomputed from the stored ciphertext, never trusted in.
        smtp: { host: "smtp.alpha.io", port: 587, user: "bot", passwordSet: false },
        resend: { apiKeySet: false },
      },
      // A bare hostname never resolves, so the SSRF guard leaves it alone.
      discord: { enabled: true, webhookUrl: "https://discord/hook" },
      slack: { enabled: true, webhookUrl: "https://slack/hook" },
      telegram: { enabled: true, chatId: "-100123", botTokenSet: false },
      webhook: { enabled: false, url: "" },
    },
    alerts: ["deployment_failed", "deployment_succeeded", "backup_failed"],
    secrets: { smtpPassword: "hunter2", telegramBotToken: "123:ABC" },
  };
}

test("getNotificationSettings returns the catalog defaults when the team has no row", async () => {
  await asUser1(async () => {
    assert.deepEqual(await getNotificationSettings(), defaultNotificationSettings());
  });
  assert.equal((await db.select().from(notificationSettings)).length, 0);
});

test("update then get round-trips every channel and the alert set", async () => {
  const next = customSettings();
  await asUser1(async () => {
    await updateNotificationSettings(next);
    const got = await getNotificationSettings();
    assert.deepEqual(got.alerts, next.alerts);
    assert.equal(got.channels.slack.webhookUrl, "https://slack/hook");
    assert.equal(got.channels.telegram.chatId, "-100123");
    assert.equal(got.channels.email.from, "deplo@alpha.io");
    // The secrets round-trip as BITS, never as values.
    assert.equal(got.channels.email.smtp.passwordSet, true);
    assert.equal(got.channels.telegram.botTokenSet, true);
  });
});

test("a saved alert set writes one row per catalog key, decided either way", async () => {
  await asUser1(() => updateNotificationSettings(customSettings()));
  const rows = await db.select().from(notificationAlerts);
  assert.equal(rows.length, ALL_ALERTS.length);
  const on = rows.filter((r) => r.enabled).map((r) => r.alertKey).sort();
  assert.deepEqual(on, ["backup_failed", "deployment_failed", "deployment_succeeded"]);
});

test("an alert with NO row falls back to its catalog default", async () => {
  await asUser1(() => updateNotificationSettings(customSettings()));
  // Simulate a key that shipped in a later release: the team has never decided
  // about it, so its row simply does not exist.
  await db
    .delete(notificationAlerts)
    .where(
      and(
        eq(notificationAlerts.teamId, TEAM_A),
        eq(notificationAlerts.alertKey, "server_offline"),
      ),
    );
  await asUser1(async () => {
    const got = await getNotificationSettings();
    assert.equal(
      got.alerts.includes("server_offline"),
      DEFAULT_ALERTS.includes("server_offline"),
      "an undecided key follows the catalog, with no backfill",
    );
  });
});

test("unknown alert keys from a client are dropped, not stored", async () => {
  const next = customSettings();
  (next.alerts as string[]).push("not_a_real_alert");
  await asUser1(() => updateNotificationSettings(next));
  const rows = await db.select().from(notificationAlerts);
  assert.equal(rows.some((r) => r.alertKey === "not_a_real_alert"), false);
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
  assert.equal((await db.select().from(notificationSettings)).length, 1);
  assert.equal(
    (await db.select().from(notificationAlerts)).length,
    ALL_ALERTS.length,
  );
});

test("an empty secret keeps the stored ciphertext; a new one replaces it", async () => {
  await asUser1(() => updateNotificationSettings(customSettings()));
  const before = (await db.select().from(notificationSettings))[0]!;

  // An edit that only moves the host, with the password field left blank.
  const untouched = customSettings();
  untouched.secrets = {};
  untouched.channels.email.smtp.host = "smtp2.alpha.io";
  await asUser1(() => updateNotificationSettings(untouched));
  const kept = (await db.select().from(notificationSettings))[0]!;
  assert.equal(kept.smtpHost, "smtp2.alpha.io");
  assert.equal(kept.smtpPasswordEnc, before.smtpPasswordEnc);
  assert.notEqual(kept.smtpPasswordEnc, "");

  const retyped = customSettings();
  retyped.secrets = { smtpPassword: "a-different-one" };
  await asUser1(() => updateNotificationSettings(retyped));
  const changed = (await db.select().from(notificationSettings))[0]!;
  assert.notEqual(changed.smtpPasswordEnc, before.smtpPasswordEnc);
});

test("the DTO carries no credential in any shape", async () => {
  await asUser1(async () => {
    await updateNotificationSettings(customSettings());
    const json = JSON.stringify(await getNotificationSettings());
    assert.equal(json.includes("hunter2"), false);
    assert.equal(json.includes("123:ABC"), false);
    assert.equal(/Enc"|password"|apiKey"|botToken"/.test(json), false);
  });
});

test("a webhook URL aimed inside the network is refused before it is stored", async () => {
  const evil = customSettings();
  evil.channels.webhook = { enabled: true, url: "https://127.0.0.1/hook" };
  await asUser1(async () => {
    await assert.rejects(
      () => updateNotificationSettings(evil),
      /private or internal/,
    );
  });
  assert.equal((await db.select().from(notificationSettings)).length, 0);
});

test("parseSettingsInput survives junk from the JSON scalar", async () => {
  const parsed = parseSettingsInput({ channels: "nope", alerts: 7 });
  assert.deepEqual(parsed.alerts, []);
  assert.equal(parsed.channels.email.provider, "smtp");
  assert.equal(parsed.channels.email.smtp.port, 587);
  assert.equal(parsed.channels.discord.enabled, false);
});

test("alertConfigForTeam resolves without any request identity", async () => {
  await asUser1(() => updateNotificationSettings(customSettings()));
  // Deliberately OUTSIDE runWithIdentity: this is the dispatcher's read, and a
  // scheduler tick has no active team.
  const cfg = await alertConfigForTeam(TEAM_A);
  assert.equal(cfg.wants("deployment_failed"), true);
  assert.equal(cfg.wants("app_crash_loop"), false);
  const kinds = cfg.channels.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["discord", "email", "push", "slack", "telegram"]);
});

test("a team with no settings row has nothing to deliver to", async () => {
  const cfg = await alertConfigForTeam(TEAM_A);
  assert.deepEqual(cfg.channels, []);
});
