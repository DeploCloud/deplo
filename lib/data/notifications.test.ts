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
import {
  ALL_ALERTS,
  ALL_CHANNELS,
  type NotificationSettingsInput,
} from "../types";
import { seedIdentity, TEAM_A, USER_1 } from "./leaf-test-helpers";
import {
  channelsForAlert,
  getNotificationSettings,
  parseSettingsInput,
  updateNotificationSettings,
} from "./notifications";

/**
 * Data-layer tests for the notification settings against pglite.
 *
 * Two halves with different storage rules and both are pinned here: the CHANNELS
 * are flat columns on one row per team (`team_id` PK, upsert), and the subscribed
 * ALERTS are rows in `notification_alerts` keyed by (team, CHANNEL, alert), where
 * an ABSENT row means "never decided" and falls back to the catalog default.
 *
 * That one fallback carries two contracts, so both have their own test: a new
 * alert key ships without a backfill, and a channel nobody has ever opened lands
 * on the catalog defaults with nothing seeded.
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

/**
 * Built from the defaults and overridden, not spelled out: twelve channels is
 * already too many to list, and channel thirteen then needs no edit here.
 * Bare hostnames never resolve, so the SSRF guard leaves them alone.
 */
function customSettings(): NotificationSettingsInput {
  const s = defaultNotificationSettings();
  return {
    channels: {
      ...s.channels,
      push: { enabled: true },
      email: {
        ...s.channels.email,
        enabled: true,
        address: "alerts@alpha.io",
        from: "deplo@alpha.io",
        // Pinned, not inherited: these tests are about the SMTP branch, and the
        // default transport is Resend.
        provider: "smtp",
        smtp: { host: "smtp.alpha.io", port: 587, user: "bot", passwordSet: false },
      },
      discord: { enabled: true, webhookUrl: "https://discord/hook" },
      slack: { enabled: true, webhookUrl: "https://slack/hook" },
      telegram: { enabled: true, chatId: "-100123", botTokenSet: false },
      ntfy: {
        enabled: true,
        baseUrl: "https://ntfy",
        topic: "deplo-alerts",
        tokenSet: false,
      },
      pushover: { enabled: true, tokenSet: false, userKeySet: false },
    },
    alerts: {
      ...s.alerts,
      discord: ["deployment_failed", "deployment_succeeded", "backup_failed"],
      slack: ["backup_failed"],
    },
    secrets: {
      smtpPassword: "hunter2",
      telegramBotToken: "123:ABC",
      pushoverToken: "pk_live",
      pushoverUserKey: "uk_live",
    },
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

test("a saved alert set writes one row per channel per catalog key", async () => {
  await asUser1(() => updateNotificationSettings(customSettings()));
  const rows = await db.select().from(notificationAlerts);
  assert.equal(rows.length, ALL_ALERTS.length * ALL_CHANNELS.length);
  const on = rows
    .filter((r) => r.enabled && r.channel === "discord")
    .map((r) => r.alertKey)
    .sort();
  assert.deepEqual(on, ["backup_failed", "deployment_failed", "deployment_succeeded"]);
});

test("each channel keeps its own selection", async () => {
  await asUser1(async () => {
    await updateNotificationSettings(customSettings());
    const got = await getNotificationSettings();
    assert.ok(got.alerts.discord.includes("deployment_succeeded"));
    assert.equal(got.alerts.slack.includes("deployment_succeeded"), false);
  });
  // And the dispatcher agrees: only the channel that asked for it is dialed.
  const kinds = (await channelsForAlert(TEAM_A, "deployment_succeeded")).map(
    (c) => c.kind,
  );
  assert.ok(kinds.includes("discord"));
  assert.equal(kinds.includes("slack"), false);
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
        eq(notificationAlerts.channel, "discord"),
        eq(notificationAlerts.alertKey, "server_offline"),
      ),
    );
  await asUser1(async () => {
    const got = await getNotificationSettings();
    assert.equal(
      got.alerts.discord.includes("server_offline"),
      DEFAULT_ALERTS.includes("server_offline"),
      "an undecided key follows the catalog, with no backfill",
    );
    // The key is per CHANNEL, so slack's own decision is untouched.
    assert.equal(got.alerts.slack.includes("server_offline"), false);
  });
});

test("a channel with no rows at all lands on the catalog defaults", async () => {
  await asUser1(() => updateNotificationSettings(customSettings()));
  // A channel nobody has ever opened: this is what "a newly enabled channel
  // starts on the defaults" actually rests on, and nothing is seeded for it.
  await db
    .delete(notificationAlerts)
    .where(
      and(
        eq(notificationAlerts.teamId, TEAM_A),
        eq(notificationAlerts.channel, "lark"),
      ),
    );
  await asUser1(async () => {
    const got = await getNotificationSettings();
    assert.deepEqual(got.alerts.lark, DEFAULT_ALERTS);
  });
});

test("unknown alert keys from a client are dropped, not stored", async () => {
  const next = customSettings();
  (next.alerts.discord as string[]).push("not_a_real_alert");
  await asUser1(() => updateNotificationSettings(next));
  const rows = await db.select().from(notificationAlerts);
  assert.equal(rows.some((r) => r.alertKey === "not_a_real_alert"), false);
});

test("an unknown channel from a client is dropped, not stored", async () => {
  const next = customSettings();
  (next.alerts as Record<string, unknown>).myspace = ["deployment_failed"];
  await asUser1(() => updateNotificationSettings(next));
  const rows = await db.select().from(notificationAlerts);
  assert.equal(rows.some((r) => r.channel === "myspace"), false);
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
    ALL_ALERTS.length * ALL_CHANNELS.length,
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
    assert.equal(json.includes("pk_live"), false);
    assert.equal(json.includes("uk_live"), false);
    assert.equal(
      /Enc"|password"|apiKey"|botToken"|userKey"|"token"/.test(json),
      false,
    );
  });
});

test("a webhook URL aimed inside the network is refused before it is stored", async () => {
  const evil = customSettings();
  // The self-hosted case the owner explicitly chose to keep refused.
  evil.channels.gotify = {
    enabled: true,
    url: "https://127.0.0.1:8080",
    tokenSet: false,
  };
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
  // Every channel is present with an empty list: the map is built by iterating
  // the catalog, never by reading the input's own keys.
  assert.deepEqual(Object.keys(parsed.alerts), [...ALL_CHANNELS]);
  assert.deepEqual(parsed.alerts.discord, []);
  assert.equal(parsed.channels.email.provider, "resend");
  assert.equal(parsed.channels.email.smtp.port, 587);
  assert.equal(parsed.channels.ntfy.baseUrl, "https://ntfy.sh");
  assert.equal(parsed.channels.discord.enabled, false);
});

test("channelsForAlert resolves without any request identity", async () => {
  await asUser1(() => updateNotificationSettings(customSettings()));
  // Deliberately OUTSIDE runWithIdentity: this is the dispatcher's read, and a
  // scheduler tick has no active team.
  const kinds = (await channelsForAlert(TEAM_A, "deployment_failed"))
    .map((c) => c.kind)
    .sort();
  // ntfy and pushover are configured and subscribed through the defaults;
  // slack asked for backup_failed only, so it is absent.
  assert.deepEqual(kinds, [
    "discord",
    "email",
    "ntfy",
    "push",
    "pushover",
    "telegram",
  ]);
});

test("a team with no settings row has nothing to deliver to", async () => {
  assert.deepEqual(await channelsForAlert(TEAM_A, "deployment_failed"), []);
});
