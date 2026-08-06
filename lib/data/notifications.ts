import "server-only";

import { eq } from "drizzle-orm";

import { ALERT_META, defaultNotificationSettings } from "../alerts";
import { decryptSecret, encryptSecret } from "../crypto";
import { getDb } from "../db/client";
import {
  notificationAlerts,
  notificationSettings,
} from "../db/schema/control-plane";
import { assertUser } from "../auth";
import {
  requireActiveTeamId,
  requireCapability,
  requireTeamWide,
} from "../membership";
import { sendToChannel, type AlertChannel } from "../notify/channels";
import {
  deletePushSubscription,
  ensureVapidKeys,
  savePushSubscription,
  type PushSubscriptionInput,
} from "../notify/web-push";
import { ALL_ALERTS } from "../types";
import { channelsToRow, rowToChannels } from "./notification-row";
import { assertSafeOutboundUrl } from "../outbound-url";
import type {
  AlertKey,
  NotificationChannel,
  NotificationSettings,
  NotificationSettingsInput,
} from "../types";

/** The active team's row, or `null` when it has none (read falls back to default). */
async function settingsRowFor(teamId: string) {
  const rows = await getDb()
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.teamId, teamId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The team's subscribed alerts. A key with no row has never been decided about,
 * so it falls back to the catalog default — which is what lets a NEW alert key
 * ship in a later release and reach every existing team with no backfill.
 */
async function alertsFor(teamId: string): Promise<AlertKey[]> {
  const rows = await getDb()
    .select({
      alertKey: notificationAlerts.alertKey,
      enabled: notificationAlerts.enabled,
    })
    .from(notificationAlerts)
    .where(eq(notificationAlerts.teamId, teamId));
  const decided = new Map(rows.map((r) => [r.alertKey, r.enabled]));
  return ALL_ALERTS.filter((a) => decided.get(a) ?? ALERT_META[a].defaultOn);
}

export async function getNotificationSettings(): Promise<NotificationSettings> {
  await requireTeamWide("notification settings");
  const teamId = await requireActiveTeamId();
  const row = await settingsRowFor(teamId);
  // Absent row = never configured → the default (PLAN §2 "Missing row = default").
  return {
    channels: row ? rowToChannels(row) : defaultNotificationSettings().channels,
    alerts: await alertsFor(teamId),
  };
}

/**
 * Coerce whatever arrived over the `JSON` scalar into a real settings object.
 *
 * The mutation's argument is an opaque scalar, so anything at all can be sent —
 * this is a trust boundary, and every field is defaulted rather than trusted.
 * Unknown alert keys are dropped by construction: the result is filtered through
 * `ALL_ALERTS`, never through the input.
 */
export function parseSettingsInput(raw: unknown): NotificationSettingsInput {
  const inp = (raw ?? {}) as Partial<NotificationSettingsInput>;
  const c = (inp.channels ?? {}) as Partial<NotificationSettings["channels"]>;
  const email = (c.email ?? {}) as Partial<NotificationSettings["channels"]["email"]>;
  const smtp = (email.smtp ?? {}) as Partial<
    NotificationSettings["channels"]["email"]["smtp"]
  >;
  const wanted = new Set(Array.isArray(inp.alerts) ? inp.alerts : []);
  const secrets = (inp.secrets ?? {}) as NonNullable<
    NotificationSettingsInput["secrets"]
  >;
  return {
    channels: {
      push: { enabled: bool(c.push?.enabled) },
      email: {
        enabled: bool(email.enabled),
        address: str(email.address),
        from: str(email.from),
        provider: email.provider === "resend" ? "resend" : "smtp",
        smtp: {
          host: str(smtp.host),
          port: port(smtp.port),
          user: str(smtp.user),
          // Write-only: the DTO's bit is recomputed from the stored ciphertext.
          passwordSet: false,
        },
        resend: { apiKeySet: false },
      },
      discord: {
        enabled: bool(c.discord?.enabled),
        webhookUrl: str(c.discord?.webhookUrl),
      },
      slack: {
        enabled: bool(c.slack?.enabled),
        webhookUrl: str(c.slack?.webhookUrl),
      },
      telegram: {
        enabled: bool(c.telegram?.enabled),
        chatId: str(c.telegram?.chatId),
        botTokenSet: false,
      },
      webhook: { enabled: bool(c.webhook?.enabled), url: str(c.webhook?.url) },
    },
    alerts: ALL_ALERTS.filter((a) => wanted.has(a)),
    secrets: {
      smtpPassword: str(secrets.smtpPassword),
      resendApiKey: str(secrets.resendApiKey),
      telegramBotToken: str(secrets.telegramBotToken),
    },
  };
}

const bool = (v: unknown): boolean => v === true;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const port = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
  return Number.isInteger(n) && n > 0 && n <= 65535 ? n : 587;
};

export async function updateNotificationSettings(
  raw: unknown,
): Promise<NotificationSettings> {
  // Notifications are an infra-level team setting.
  const teamId = (await requireCapability("manage_notifications")).teamId;
  const next = parseSettingsInput(raw);
  const c = next.channels;

  // Webhook URLs are dialed FROM the control plane (test send + alert
  // dispatch) — reject private/internal targets before they are ever
  // persisted, so no dispatcher can be fed one (SSRF).
  if (c.discord.webhookUrl)
    await assertSafeOutboundUrl(c.discord.webhookUrl, "Discord webhook URL");
  if (c.slack.webhookUrl)
    await assertSafeOutboundUrl(c.slack.webhookUrl, "Slack webhook URL");
  if (c.webhook.url) await assertSafeOutboundUrl(c.webhook.url, "Webhook URL");

  // Read the stored ciphertext BEFORE the transaction (a query on its own
  // connection inside one deadlocks the test harness) — an empty secret means
  // "keep the stored one", so an edit that only moves the SMTP host must not
  // require retyping the password.
  const prev = await settingsRowFor(teamId);
  const keep = (fresh: string | undefined, stored: string | undefined) =>
    fresh ? encryptSecret(fresh) : (stored ?? "");
  const row = channelsToRow(teamId, c, {
    smtpPasswordEnc: keep(next.secrets?.smtpPassword, prev?.smtpPasswordEnc),
    resendApiKeyEnc: keep(next.secrets?.resendApiKey, prev?.resendApiKeyEnc),
    telegramBotTokenEnc: keep(
      next.secrets?.telegramBotToken,
      prev?.telegramBotTokenEnc,
    ),
  });

  const enabled = new Set(next.alerts);
  await getDb().transaction(async (tx) => {
    // One row per team (team_id PK): upsert so the first save inserts and later
    // saves overwrite — never a duplicate row.
    await tx
      .insert(notificationSettings)
      .values(row)
      .onConflictDoUpdate({ target: notificationSettings.teamId, set: row });
    // The form always posts the whole set, so replace it wholesale: that also
    // retires keys the catalog dropped, with no separate cleanup.
    await tx
      .delete(notificationAlerts)
      .where(eq(notificationAlerts.teamId, teamId));
    await tx.insert(notificationAlerts).values(
      ALL_ALERTS.map((a) => ({
        teamId,
        alertKey: a,
        enabled: enabled.has(a),
      })),
    );
  });

  return { channels: rowToChannels(row), alerts: [...next.alerts] };
}

/* ------------------------------------------------------------------ */
/* The dispatcher's read (UNGATED, background-safe)                    */
/* ------------------------------------------------------------------ */

export interface TeamAlertConfig {
  /** Only channels that are BOTH switched on and actually configured. */
  channels: AlertChannel[];
  /** Whether this team wants to hear about `key`. */
  wants(key: AlertKey): boolean;
}

/**
 * What a team's alerts should be delivered to, resolved WITHOUT a request.
 *
 * Deliberately ungated and `teamId`-by-parameter, like `recordServerHealth` and
 * `executeBackup`: most alerts are raised by a deploy runner, a scheduler tick
 * or a telemetry stream, none of which has an active team or a user. It is
 * INTERNAL — never exported through GraphQL, never called from a resolver;
 * `getNotificationSettings()` stays the only request-facing read, with both
 * gates on it. Nothing here reads or writes anything a user could target.
 *
 * Returns plaintext credentials, so it must never reach a DTO.
 */
export async function alertConfigForTeam(
  teamId: string,
): Promise<TeamAlertConfig> {
  const [row, alerts] = await Promise.all([
    settingsRowFor(teamId),
    alertsFor(teamId),
  ]);
  const on = new Set(alerts);
  return {
    channels: row ? configuredChannels(row) : [],
    wants: (key) => on.has(key),
  };
}

type SettingsRow = NonNullable<Awaited<ReturnType<typeof settingsRowFor>>>;

/** The switched-on channels that have everything they need to actually send. */
function configuredChannels(row: SettingsRow): AlertChannel[] {
  const out: AlertChannel[] = [];
  if (row.discordEnabled && row.discordWebhookUrl)
    out.push({ kind: "discord", webhookUrl: row.discordWebhookUrl });
  if (row.slackEnabled && row.slackWebhookUrl)
    out.push({ kind: "slack", webhookUrl: row.slackWebhookUrl });
  if (row.telegramEnabled && row.telegramBotTokenEnc && row.telegramChatId)
    out.push({
      kind: "telegram",
      botToken: decryptSecret(row.telegramBotTokenEnc),
      chatId: row.telegramChatId,
    });
  if (row.webhookEnabled && row.webhookUrl)
    out.push({ kind: "webhook", url: row.webhookUrl });
  const email = emailChannel(row);
  if (email) out.push(email);
  if (row.pushEnabled) out.push({ kind: "push", teamId: row.teamId });
  return out;
}

/** The email channel, or null when the chosen transport isn't fully configured. */
function emailChannel(row: SettingsRow): AlertChannel | null {
  if (!row.emailEnabled || !row.emailAddress) return null;
  const from = row.emailFrom || row.emailAddress;
  if (row.emailProvider === "resend") {
    if (!row.resendApiKeyEnc) return null;
    return {
      kind: "email",
      to: row.emailAddress,
      config: {
        provider: "resend",
        apiKey: decryptSecret(row.resendApiKeyEnc),
        from,
      },
    };
  }
  if (!row.smtpHost) return null;
  return {
    kind: "email",
    to: row.emailAddress,
    config: {
      provider: "smtp",
      host: row.smtpHost,
      port: row.smtpPort,
      user: row.smtpUser,
      password: row.smtpPasswordEnc ? decryptSecret(row.smtpPasswordEnc) : "",
      from,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Test sends and browser push                                         */
/* ------------------------------------------------------------------ */

/**
 * Deliver a one-off test alert through a single channel using the saved config.
 * Browser push goes to the CALLER's own devices; every other channel goes to the
 * team's configured endpoint.
 */
export async function sendTestNotification(
  channel: NotificationChannel,
): Promise<void> {
  // Sending a real outbound POST is a side-effecting infra action — gate it the
  // same way as editing the settings, so a view-only member can't drive traffic
  // to the team's configured endpoints.
  const { teamId, userId } = await requireCapability("manage_notifications");
  const row = await settingsRowFor(teamId);
  if (!row) throw new Error("Save your notification settings first");

  const target = testChannel(row, channel, userId);
  await sendToChannel(target, {
    key: "deployment_failed",
    title: "Deplo test alert",
    body: "This channel is wired up correctly.",
    url: null,
    ts: new Date().toISOString(),
  });
}

/** The one channel being tested, with the error the user needs if it isn't ready. */
function testChannel(
  row: SettingsRow,
  channel: NotificationChannel,
  userId: string,
): AlertChannel {
  switch (channel) {
    case "discord":
      if (!row.discordWebhookUrl)
        throw new Error("Add a Discord webhook URL first");
      return { kind: "discord", webhookUrl: row.discordWebhookUrl };
    case "slack":
      if (!row.slackWebhookUrl) throw new Error("Add a Slack webhook URL first");
      return { kind: "slack", webhookUrl: row.slackWebhookUrl };
    case "telegram":
      if (!row.telegramBotTokenEnc || !row.telegramChatId)
        throw new Error("Add a Telegram bot token and chat id first");
      return {
        kind: "telegram",
        botToken: decryptSecret(row.telegramBotTokenEnc),
        chatId: row.telegramChatId,
      };
    case "webhook":
      if (!row.webhookUrl) throw new Error("Add a webhook URL first");
      return { kind: "webhook", url: row.webhookUrl };
    case "email": {
      if (!row.emailAddress) throw new Error("Add an email address first");
      const email = emailChannel({ ...row, emailEnabled: true });
      if (!email)
        throw new Error(
          row.emailProvider === "resend"
            ? "Add a Resend API key first"
            : "Add an SMTP host first",
        );
      return email;
    }
    case "push":
      return { kind: "push", teamId: row.teamId, userId };
  }
}

/** The instance's VAPID public key, minted on first use. Public by design. */
export async function getWebPushPublicKey(): Promise<string> {
  await assertUser();
  return ensureVapidKeys();
}

/**
 * Opt this browser in. Gated on being a member of the active team, NOT on
 * `manage_notifications`: subscribing your own device is your own business, the
 * same way revoking your own session is.
 */
export async function subscribeWebPush(
  sub: PushSubscriptionInput,
): Promise<void> {
  const user = await assertUser();
  const teamId = await requireActiveTeamId();
  if (!sub.endpoint || !sub.p256dh || !sub.auth)
    throw new Error("The browser did not return a usable subscription");
  await savePushSubscription(teamId, user.id, sub);
}

/** Opt this browser back out. Scoped to the caller's own row. */
export async function unsubscribeWebPush(endpoint: string): Promise<void> {
  const user = await assertUser();
  const teamId = await requireActiveTeamId();
  await deletePushSubscription(teamId, user.id, endpoint);
}

