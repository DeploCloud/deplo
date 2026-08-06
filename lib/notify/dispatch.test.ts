import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { PGlite } from "@electric-sql/pglite";

import { makeTestDb, type TestDb } from "../db/test-harness";
import { __setTestDb, __resetTestDb } from "../db/client";
import { runWithIdentity } from "../auth/request-context";
import { setStoredPublicBaseUrl } from "../public-url";
import {
  seedIdentity,
  TEAM_A,
  TEAM_B,
  USER_1,
} from "../data/leaf-test-helpers";
import { updateNotificationSettings } from "../data/notifications";
import { captureFetch, type FetchCapture } from "./fetch-capture-test-helpers";
import { __resetCooldowns } from "./cooldown";
import { dispatchAlertNow } from "./dispatch";
import type { NotificationSettingsInput } from "../types";

/**
 * The dispatcher end to end against pglite: settings in the database, real
 * channel senders, one stubbed `fetch`.
 *
 * The first test is the regression net for the whole feature — it pins the exact
 * body each channel puts on the wire. Everything below it is about what must NOT
 * go out: an alert nobody subscribed to, a channel that is off, another team's
 * endpoints, and a path that leaked as a bare string because the panel URL was
 * unknown.
 */

let db: TestDb;
let pg: PGlite;
let capture: FetchCapture | null = null;

before(async () => {
  ({ db, pg } = await makeTestDb());
  __setTestDb(db);
});

after(async () => {
  __resetTestDb();
  await pg.close();
  setStoredPublicBaseUrl(null);
});

beforeEach(async () => {
  await pg.exec(
    `truncate table notification_alerts, notification_settings, users, teams restart identity cascade;`,
  );
  await seedIdentity(db);
  __resetCooldowns();
  setStoredPublicBaseUrl("https://deplo.acme.com");
});

afterEach(() => {
  capture?.restore();
  capture = null;
});

/** Channels that all POST, so one alert produces three comparable calls. */
function webhookChannels(
  alerts: NotificationSettingsInput["alerts"],
): NotificationSettingsInput {
  return {
    channels: {
      push: { enabled: false },
      email: {
        enabled: false,
        address: "",
        from: "",
        provider: "smtp",
        smtp: { host: "", port: 587, user: "", passwordSet: false },
        resend: { apiKeySet: false },
      },
      // Bare hostnames: they never resolve, so the SSRF guard passes them through
      // and the stubbed fetch is what answers.
      discord: { enabled: true, webhookUrl: "https://discord/hook" },
      slack: { enabled: true, webhookUrl: "https://slack/hook" },
      telegram: { enabled: false, chatId: "", botTokenSet: false },
      webhook: { enabled: true, url: "https://ops/hook" },
    },
    alerts,
  };
}

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("one alert reaches every enabled channel, in each one's own shape", async () => {
  await asUser1(() =>
    updateNotificationSettings(webhookChannels(["deployment_failed"])),
  );
  capture = captureFetch();

  await dispatchAlertNow({
    teamId: TEAM_A,
    key: "deployment_failed",
    title: "api failed to deploy",
    body: "The build log has the error that stopped it.",
    path: "/apps/api",
  });

  assert.equal(capture.calls.length, 3);
  const by = (host: string) =>
    capture!.calls.find((c) => c.url.includes(host))!;

  assert.deepEqual(by("discord").body, {
    content:
      "**api failed to deploy**\nThe build log has the error that stopped it.\nhttps://deplo.acme.com/apps/api",
  });
  assert.deepEqual(by("slack").body, {
    text: "*api failed to deploy*\nThe build log has the error that stopped it.\nhttps://deplo.acme.com/apps/api",
  });
  const generic = by("ops").body as Record<string, unknown>;
  assert.equal(generic.event, "deployment_failed");
  assert.equal(generic.title, "api failed to deploy");
  assert.equal(generic.url, "https://deplo.acme.com/apps/api");
  assert.equal(typeof generic.ts, "string");

  for (const call of capture.calls) assert.equal(call.method, "POST");
});

test("an alert the team did not subscribe to sends nothing", async () => {
  await asUser1(() =>
    updateNotificationSettings(webhookChannels(["backup_failed"])),
  );
  capture = captureFetch();
  await dispatchAlertNow({
    teamId: TEAM_A,
    key: "deployment_failed",
    title: "x",
    body: "y",
  });
  assert.equal(capture.calls.length, 0);
});

test("a channel that is switched off is never dialed", async () => {
  const settings = webhookChannels(["deployment_failed"]);
  settings.channels.slack.enabled = false;
  settings.channels.webhook.enabled = false;
  await asUser1(() => updateNotificationSettings(settings));
  capture = captureFetch();
  await dispatchAlertNow({
    teamId: TEAM_A,
    key: "deployment_failed",
    title: "x",
    body: "y",
  });
  assert.equal(capture.calls.length, 1);
  assert.match(capture.calls[0].url, /discord/);
});

test("a channel enabled but not configured is not dialed either", async () => {
  const settings = webhookChannels(["deployment_failed"]);
  settings.channels.webhook = { enabled: true, url: "" };
  await asUser1(() => updateNotificationSettings(settings));
  capture = captureFetch();
  await dispatchAlertNow({
    teamId: TEAM_A,
    key: "deployment_failed",
    title: "x",
    body: "y",
  });
  assert.equal(capture.calls.some((c) => c.url.includes("ops")), false);
});

test("one dead channel does not silence the others, and nothing throws", async () => {
  await asUser1(() =>
    updateNotificationSettings(webhookChannels(["deployment_failed"])),
  );
  capture = captureFetch((url) =>
    url.includes("discord")
      ? new Response("nope", { status: 500 })
      : new Response("{}", { status: 200 }),
  );
  // Must RESOLVE: an alert that rejects would take down the deploy that raised it.
  await dispatchAlertNow({
    teamId: TEAM_A,
    key: "deployment_failed",
    title: "x",
    body: "y",
  });
  assert.equal(capture.calls.length, 3);
});

test("with no panel address, a path never leaks as a bare string", async () => {
  setStoredPublicBaseUrl(null);
  const before = process.env.DEPLO_PUBLIC_URL;
  delete process.env.DEPLO_PUBLIC_URL;
  try {
    await asUser1(() =>
      updateNotificationSettings(webhookChannels(["deployment_failed"])),
    );
    capture = captureFetch();
    await dispatchAlertNow({
      teamId: TEAM_A,
      key: "deployment_failed",
      title: "x",
      body: "y",
      path: "/apps/api",
    });
    const generic = capture.calls.find((c) => c.url.includes("ops"))!
      .body as Record<string, unknown>;
    assert.equal(generic.url, null);
    const discord = capture.calls.find((c) => c.url.includes("discord"))!
      .body as { content: string };
    assert.equal(discord.content.includes("/apps/api"), false);
  } finally {
    if (before !== undefined) process.env.DEPLO_PUBLIC_URL = before;
  }
});

test("an alert for one team never reads another team's endpoints", async () => {
  await asUser1(() =>
    updateNotificationSettings(webhookChannels(["deployment_failed"])),
  );
  capture = captureFetch();
  await dispatchAlertNow({
    teamId: TEAM_B,
    key: "deployment_failed",
    title: "x",
    body: "y",
  });
  assert.equal(capture.calls.length, 0);
});

test("a repeated condition is deduped, and the state change gets through", async () => {
  await asUser1(() =>
    updateNotificationSettings(webhookChannels(["server_offline"])),
  );
  capture = captureFetch();
  const offline = {
    teamId: TEAM_A,
    key: "server_offline" as const,
    title: "eu-main-1 is offline",
    body: "It stopped answering.",
    dedupe: { id: "server:srv_1", state: "offline" },
  };
  await dispatchAlertNow(offline);
  await dispatchAlertNow(offline);
  assert.equal(capture.calls.length, 3, "the second observation is suppressed");

  await dispatchAlertNow({
    ...offline,
    title: "eu-main-1 is back online",
    dedupe: { id: "server:srv_1", state: "online" },
  });
  assert.equal(capture.calls.length, 6, "the recovery edge is not suppressed");
});
