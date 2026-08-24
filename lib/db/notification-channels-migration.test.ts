import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { PGlite, types } from "@electric-sql/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

import { isoTimestampParser } from "./timestamp-parser";
import { schema } from "./schema";
import { seedIdentity, TEAM_A, TEAM_B } from "../data/identity-test-helpers";
import { ALL_CHANNELS } from "../types";

/**
 * The data carry-over of migration 0075 — twelve fixed channel slots becoming N
 * configured instances.
 *
 * The normal harness replays the journal onto an EMPTY database, so it proves
 * the DDL is valid and proves nothing at all about a team that already had
 * channels configured. That is the only interesting half of this migration, and
 * this file is the only thing that covers it: replay 0000…0074, seed the old
 * world, apply 0075, and read what came out.
 *
 * The seeds are RAW SQL on purpose. They write `notification_settings`, which
 * 0075 drops and the live drizzle schema therefore no longer knows — a drizzle
 * insert names every column of the table object it is given, and that object
 * does not exist any more.
 */

const MIG_DIR = path.join(process.cwd(), "lib", "db", "migrations");

let pg: PGlite;
let db: PgliteDatabase<typeof schema>;

/** Apply one migration file, statement by statement (drizzle's breakpoint split). */
async function applyFile(file: string): Promise<void> {
  const sql = readFileSync(path.join(MIG_DIR, file), "utf8");
  for (const chunk of sql.split("--> statement-breakpoint")) {
    const s = chunk.trim();
    if (s) await pg.exec(s);
  }
}

before(async () => {
  pg = new PGlite({
    parsers: {
      [types.TIMESTAMPTZ]: isoTimestampParser,
      [types.TIMESTAMP]: isoTimestampParser,
    },
  });
  db = drizzle(pg, { schema });

  const files = readdirSync(MIG_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  // 0085 rides along: it adds one column to `teams`, which the live-drizzle
  // seed below names in its INSERT. Any later additive column on a seeded table
  // needs the same treatment — 0098 (the two MCP switches) is the next one.
  const preSeed = (f: string): boolean =>
    Number(f.slice(0, 4)) < 75 ||
    f.startsWith("0085_") ||
    f.startsWith("0098_") ||
    // Same reason as in shared-env-migration.test.ts: 0115 is the single
    // additive `account.issuer` ALTER that `seedIdentity` needs, split from the
    // OAuth half (0116) precisely so it can be pulled forward here.
    f.startsWith("0115_");
  for (const f of files.filter(preSeed)) await applyFile(f);

  // Teams and users through the live schema: 0075 does not touch them.
  await seedIdentity(db);

  // TEAM_A: one of everything worth distinguishing.
  //  discord    enabled + configured        -> an instance
  //  slack      configured but switched OFF -> an instance, still off
  //  lark       neither                     -> nothing
  //  ntfy       ONLY the NOT NULL default    -> nothing (the trap)
  //  push       enabled, no config at all   -> an instance
  //  email      smtp password AND resend key -> both secret slots
  await pg.exec(`
    INSERT INTO notification_settings (
      team_id, push_enabled,
      email_enabled, email_address, email_from, email_provider,
      smtp_host, smtp_port, smtp_user, smtp_password_enc, resend_api_key_enc,
      discord_enabled, discord_webhook_url,
      slack_enabled, slack_webhook_url,
      telegram_enabled, telegram_bot_token_enc, telegram_chat_id,
      webhook_enabled, webhook_url,
      lark_enabled, lark_webhook_url,
      msteams_enabled, msteams_webhook_url,
      mattermost_enabled, mattermost_webhook_url,
      gotify_enabled, gotify_url, gotify_token_enc,
      ntfy_enabled, ntfy_base_url, ntfy_topic, ntfy_token_enc,
      pushover_enabled, pushover_token_enc, pushover_user_key_enc
    ) VALUES (
      '${TEAM_A}', true,
      true, 'alerts@alpha.io', 'deplo@alpha.io', 'smtp',
      'smtp.alpha.io', 2525, 'bot', 'v1.enc.smtp', 'v1.enc.resend',
      true, 'https://discord.example/hook/tok',
      false, 'https://slack.example/services/tok',
      false, '', '',
      false, '',
      false, '',
      false, '',
      false, '',
      false, '', '',
      false, 'https://ntfy.sh', '', '',
      false, '', ''
    );
  `);

  // TEAM_B: nothing configured at all except the columns that cannot be empty.
  await pg.exec(`
    INSERT INTO notification_settings (
      team_id, push_enabled, email_enabled, email_address,
      discord_enabled, discord_webhook_url, webhook_enabled, webhook_url
    ) VALUES ('${TEAM_B}', false, false, '', false, '', false, '');
  `);

  // Decisions in the OLD shape: keyed by (team, channel TYPE, alert).
  await pg.exec(`
    INSERT INTO notification_alerts (team_id, channel, alert_key, enabled) VALUES
      ('${TEAM_A}', 'discord', 'deployment_failed',    true),
      ('${TEAM_A}', 'discord', 'deployment_succeeded', true),
      ('${TEAM_A}', 'slack',   'backup_failed',        true),
      ('${TEAM_A}', 'slack',   'deployment_failed',    false),
      ('${TEAM_A}', 'lark',    'deployment_failed',    true);
  `);

  await applyFile("0075_notification_channel_instances.sql");
});

after(async () => {
  await pg.close();
});

type Chan = {
  id: string;
  kind: string;
  enabled: boolean;
  url: string;
  target: string;
  secret_enc: string;
  secret2_enc: string;
  smtp_host: string;
  smtp_port: number;
  name: string;
};

async function channels(teamId: string): Promise<Chan[]> {
  return (
    await pg.query<Chan>(
      `SELECT id, kind, enabled, url, target, secret_enc, secret2_enc,
              smtp_host, smtp_port, name
         FROM notification_channels WHERE team_id = $1 ORDER BY created_at`,
      [teamId],
    )
  ).rows;
}

test("an enabled, configured type becomes an instance and keeps its alerts", async () => {
  const discord = (await channels(TEAM_A)).find((c) => c.kind === "discord");
  assert.ok(discord, "discord should have become an instance");
  assert.equal(discord.enabled, true);
  assert.equal(discord.url, "https://discord.example/hook/tok");
  assert.equal(discord.name, "", "nothing to name it after, so it starts unnamed");

  const alerts = (
    await pg.query<{ alert_key: string; enabled: boolean }>(
      `SELECT alert_key, enabled FROM notification_alerts WHERE channel_id = $1 ORDER BY alert_key`,
      [discord.id],
    )
  ).rows;
  assert.deepEqual(
    alerts.map((a) => a.alert_key),
    ["deployment_failed", "deployment_succeeded"],
  );
  assert.ok(alerts.every((a) => a.enabled));
});

test("a type configured but switched off survives, still off", async () => {
  const slack = (await channels(TEAM_A)).find((c) => c.kind === "slack");
  assert.ok(slack, "a saved endpoint is configuration, switch or no switch");
  assert.equal(slack.enabled, false);
  assert.equal(slack.url, "https://slack.example/services/tok");

  // And its selection came with it, including the deliberate `false`.
  const alerts = (
    await pg.query<{ alert_key: string; enabled: boolean }>(
      `SELECT alert_key, enabled FROM notification_alerts WHERE channel_id = $1 ORDER BY alert_key`,
      [slack.id],
    )
  ).rows;
  assert.deepEqual(alerts, [
    { alert_key: "backup_failed", enabled: true },
    { alert_key: "deployment_failed", enabled: false },
  ]);
});

test("a type that was neither enabled nor configured becomes nothing", async () => {
  const kinds = (await channels(TEAM_A)).map((c) => c.kind);
  assert.equal(kinds.includes("lark"), false);
  assert.equal(kinds.includes("telegram"), false);
  // Its decisions had nothing left to be decisions about.
  const orphans = (
    await pg.query<{ n: string }>(
      `SELECT count(*) AS n FROM notification_alerts a
         LEFT JOIN notification_channels c ON c.id = a.channel_id
        WHERE c.id IS NULL`,
    )
  ).rows[0];
  assert.equal(Number(orphans.n), 0);
});

test("ntfy's NOT NULL default base URL is not evidence of anything", async () => {
  // `ntfy_base_url` defaults to https://ntfy.sh on EVERY row ever written, so a
  // naive "any non-empty field means configured" would hand an ntfy channel to
  // every team on the instance. This is that regression, pinned.
  for (const team of [TEAM_A, TEAM_B]) {
    const kinds = (await channels(team)).map((c) => c.kind);
    assert.equal(kinds.includes("ntfy"), false, `${team} should have no ntfy`);
  }
});

test("browser push carries no config, so being ON is the whole of it", async () => {
  const push = (await channels(TEAM_A)).find((c) => c.kind === "push");
  assert.ok(push);
  assert.equal(push.enabled, true);
  assert.equal(push.url, "");
  assert.equal(push.target, "");
  assert.equal(push.secret_enc, "");
});

test("email fills BOTH secret slots, so switching transport strands nothing", async () => {
  const email = (await channels(TEAM_A)).find((c) => c.kind === "email");
  assert.ok(email);
  assert.equal(email.target, "alerts@alpha.io", "the To: is the target");
  assert.equal(email.secret_enc, "v1.enc.smtp");
  assert.equal(email.secret2_enc, "v1.enc.resend");
  assert.equal(email.smtp_host, "smtp.alpha.io");
  assert.equal(email.smtp_port, 2525, "a non-default port is not a default");
});

test("a team with nothing configured comes out with no channels at all", async () => {
  assert.deepEqual(await channels(TEAM_B), []);
});

test("the instances come out in catalog order, not the planner's", async () => {
  // `now()` is the transaction's clock, so without the ordinal offset in the
  // INSERT every row would share a timestamp and this order would be luck.
  const kinds = (await channels(TEAM_A)).map((c) => c.kind);
  const expected = ALL_CHANNELS.filter((k) => kinds.includes(k));
  assert.deepEqual(kinds, expected);
});

test("notification_settings is gone", async () => {
  const rows = (
    await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'notification_settings'`,
    )
  ).rows;
  assert.deepEqual(rows, []);
});
