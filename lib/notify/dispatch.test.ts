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
import {
  listNotificationChannels,
  saveNotificationChannel,
} from "../data/notifications";
import { captureFetch, type FetchCapture } from "./fetch-capture-test-helpers";
import { __resetCooldowns } from "./cooldown";
import { dispatchAlertNow } from "./dispatch";
import type { AlertKey, NotificationChannel } from "../types";

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
    `truncate table notification_alerts, notification_channels, users, teams restart identity cascade;`,
  );
  await seedIdentity(db);
  __resetCooldowns();
  setStoredPublicBaseUrl("https://deplo.acme.com");
});

afterEach(() => {
  capture?.restore();
  capture = null;
});

/**
 * One configured channel per kind that POSTs, so a single alert produces nine
 * comparable calls, each subscribed to the same list.
 *
 * Bare hostnames: they never resolve, so the outbound guard passes them through
 * and the stubbed fetch is what answers. Pushover skips the guard entirely
 * (fixed host, credentials in the body), which is what keeps this hermetic.
 */
async function seedChannels(alerts: AlertKey[]): Promise<void> {
  const kinds: [NotificationChannel, Partial<Record<string, unknown>>][] = [
    ["discord", { url: "https://discord/hook" }],
    ["slack", { url: "https://slack/hook" }],
    ["webhook", { url: "https://ops/hook" }],
    ["lark", { url: "https://lark/hook" }],
    ["msteams", { url: "https://msteams/hook" }],
    ["mattermost", { url: "https://mattermost/hook" }],
    ["gotify", { url: "https://gotify", secrets: { secret: "gotify-token" } }],
    [
      "ntfy",
      {
        url: "https://ntfy",
        target: "deplo",
        secrets: { secret: "ntfy-token" },
      },
    ],
    ["pushover", { secrets: { secret: "po-token", secret2: "po-user" } }],
  ];
  await asUser1(async () => {
    for (const [kind, config] of kinds)
      await saveNotificationChannel(null, {
        kind,
        name: "",
        enabled: true,
        url: "",
        target: "",
        emailFrom: "",
        emailProvider: "resend",
        smtpHost: "",
        smtpPort: 587,
        smtpUser: "",
        alerts,
        ...config,
      });
  });
}

const asUser1 = <T>(fn: () => Promise<T>): Promise<T> =>
  runWithIdentity({ userId: USER_1, teamId: TEAM_A }, fn);

test("one alert reaches every enabled channel, in each one's own shape", async () => {
  await seedChannels(["deployment_failed"]);
  capture = captureFetch();

  await dispatchAlertNow({
    teamId: TEAM_A,
    key: "deployment_failed",
    title: "api failed to deploy",
    body: "The build log has the error that stopped it.",
    path: "/apps/api",
  });

  assert.equal(capture.calls.length, 9);
  const by = (host: string) =>
    capture!.calls.find((c) => c.url.includes(host))!;
  const link = "https://deplo.acme.com/apps/api";
  const body = "The build log has the error that stopped it.";

  // Discord is the one structured payload: an embed, not a line of text.
  const { timestamp, ...embed } = (
    by("discord").body as { embeds: Record<string, unknown>[] }
  ).embeds[0];
  assert.equal(typeof timestamp, "string");
  assert.deepEqual(embed, {
    author: { name: "Deplo · Deployments" },
    title: "api failed to deploy",
    url: link,
    description: body,
    color: 0xff5c5c,
    fields: [{ name: "Event", value: "Deployment failed", inline: true }],
  });
  assert.deepEqual(by("slack").body, {
    text: `*api failed to deploy*\n${body}\n${link}`,
  });
  assert.deepEqual(by("lark").body, {
    msg_type: "text",
    content: { text: `api failed to deploy\n${body}\n${link}` },
  });
  assert.deepEqual(by("msteams").body, {
    text: `**api failed to deploy**\n\n${body}\n${link}`,
  });
  assert.deepEqual(by("mattermost").body, {
    text: `**api failed to deploy**\n${body}\n${link}`,
  });
  assert.deepEqual(by("gotify").body, {
    title: "api failed to deploy",
    message: `${body}\n${link}`,
    priority: 5,
  });
  assert.deepEqual(by("ntfy").body, {
    topic: "deplo",
    title: "api failed to deploy",
    message: body,
    priority: 4,
    click: link,
  });
  assert.deepEqual(by("pushover").body, {
    token: "po-token",
    user: "po-user",
    title: "api failed to deploy",
    message: body,
    url: link,
  });
  const generic = by("ops").body as Record<string, unknown>;
  assert.equal(generic.event, "deployment_failed");
  assert.equal(generic.title, "api failed to deploy");
  assert.equal(generic.url, link);
  assert.equal(typeof generic.ts, "string");

  // The two channels that authenticate with a header, not a body field.
  assert.equal(by("gotify").headers["X-Gotify-Key"], "gotify-token");
  assert.equal(by("ntfy").headers.Authorization, "Bearer ntfy-token");
  // Gotify's token must never ride in the URL, where an access log would keep it.
  assert.equal(by("gotify").url, "https://gotify/message");

  for (const call of capture.calls) assert.equal(call.method, "POST");
});

test("a channel only gets the alerts IT subscribed to", async () => {
  await seedChannels(["deployment_failed"]);
  // Two channels of the SAME kind, deliberately: the one thing that used to be
  // impossible to express, and the one an `alerts[kind]` lookup gets wrong.
  await asUser1(() =>
    saveNotificationChannel(null, {
      kind: "slack",
      name: "Backups room",
      enabled: true,
      url: "https://slack/backups",
      target: "",
      emailFrom: "",
      emailProvider: "resend",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      alerts: ["backup_failed"],
    }),
  );
  capture = captureFetch();
  await dispatchAlertNow({
    teamId: TEAM_A,
    key: "backup_failed",
    title: "Backup of db failed",
    body: "y",
  });
  assert.equal(capture.calls.length, 1, "only the room that asked for it");
  assert.equal(capture.calls[0].url, "https://slack/backups");
});

test("an alert the team did not subscribe to sends nothing", async () => {
  await seedChannels(["backup_failed"]);
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
  await seedChannels(["deployment_failed"]);
  await asUser1(async () => {
    for (const c of await listNotificationChannels())
      if (c.kind === "slack" || c.kind === "webhook")
        await saveNotificationChannel(c.id, { ...c, enabled: false });
  });
  capture = captureFetch();
  await dispatchAlertNow({
    teamId: TEAM_A,
    key: "deployment_failed",
    title: "x",
    body: "y",
  });
  assert.equal(capture.calls.length, 7);
  assert.equal(
    capture.calls.some((c) => c.url.includes("slack")),
    false,
  );
  assert.equal(
    capture.calls.some((c) => c.url.includes("ops")),
    false,
  );
});

test("a channel enabled but not configured is not dialed either", async () => {
  await seedChannels(["deployment_failed"]);
  await asUser1(async () => {
    for (const c of await listNotificationChannels())
      if (c.kind === "webhook")
        await saveNotificationChannel(c.id, { ...c, url: "" });
  });
  capture = captureFetch();
  await dispatchAlertNow({
    teamId: TEAM_A,
    key: "deployment_failed",
    title: "x",
    body: "y",
  });
  assert.equal(
    capture.calls.some((c) => c.url.includes("ops")),
    false,
  );
});

test("one dead channel does not silence the others, and nothing throws", async () => {
  await seedChannels(["deployment_failed"]);
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
  assert.equal(capture.calls.length, 9);
});

test("with no panel address, a path never leaks as a bare string", async () => {
  setStoredPublicBaseUrl(null);
  const before = process.env.DEPLO_PUBLIC_URL;
  delete process.env.DEPLO_PUBLIC_URL;
  try {
    await seedChannels(["deployment_failed"]);
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
      .body as { embeds: { url?: string }[] };
    // No panel address ⇒ no title link at all, never a bare path.
    assert.equal(JSON.stringify(discord).includes("/apps/api"), false);
    assert.equal(discord.embeds[0].url, undefined);
  } finally {
    if (before !== undefined) process.env.DEPLO_PUBLIC_URL = before;
  }
});

test("an alert for one team never reads another team's endpoints", async () => {
  await seedChannels(["deployment_failed"]);
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
  await seedChannels(["server_offline"]);
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
  assert.equal(capture.calls.length, 9, "the second observation is suppressed");

  await dispatchAlertNow({
    ...offline,
    title: "eu-main-1 is back online",
    dedupe: { id: "server:srv_1", state: "online" },
  });
  assert.equal(capture.calls.length, 18, "the recovery edge is not suppressed");
});
