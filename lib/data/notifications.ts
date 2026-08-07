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
import { ALL_ALERTS, ALL_CHANNELS } from "../types";
import { channelsToRow, rowToChannels } from "./notification-row";
import { assertSafeOutboundUrl } from "../outbound-url";
import type {
  AlertKey,
  ChannelAlerts,
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
 * What each channel is subscribed to.
 *
 * A `(channel, key)` with no row has never been decided about, so it falls back
 * to the catalog default. That one rule does double duty: it lets a NEW alert
 * key ship in a later release and reach every existing team with no backfill,
 * AND it makes a channel nobody has ever opened resolve to exactly
 * `DEFAULT_ALERTS` — which is the whole implementation of "a newly enabled
 * channel starts on the defaults", with nothing to seed.
 */
async function alertsFor(teamId: string): Promise<ChannelAlerts> {
  const rows = await getDb()
    .select({
      channel: notificationAlerts.channel,
      alertKey: notificationAlerts.alertKey,
      enabled: notificationAlerts.enabled,
    })
    .from(notificationAlerts)
    .where(eq(notificationAlerts.teamId, teamId));
  const decided = new Map(
    rows.map((r) => [`${r.channel}:${r.alertKey}`, r.enabled]),
  );
  return Object.fromEntries(
    ALL_CHANNELS.map((c) => [
      c,
      ALL_ALERTS.filter(
        (a) => decided.get(`${c}:${a}`) ?? ALERT_META[a].defaultOn,
      ),
    ]),
  ) as ChannelAlerts;
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
 *
 * Unknown channels AND unknown alert keys are both dropped BY CONSTRUCTION, not
 * by a validation step somebody could skip: the map is built by iterating
 * `ALL_CHANNELS` and each list by filtering `ALL_ALERTS`, never by reading the
 * input's own keys. A channel missing from the input coerces to `[]` rather than
 * to the defaults, which is safe because `getNotificationSettings` always hands
 * the client a full twelve-key map to round-trip.
 */
export function parseSettingsInput(raw: unknown): NotificationSettingsInput {
  const inp = (raw ?? {}) as Partial<NotificationSettingsInput>;
  const c = (inp.channels ?? {}) as Partial<NotificationSettings["channels"]>;
  const email = (c.email ?? {}) as Partial<NotificationSettings["channels"]["email"]>;
  const smtp = (email.smtp ?? {}) as Partial<
    NotificationSettings["channels"]["email"]["smtp"]
  >;
  const rawAlerts = (inp.alerts ?? {}) as Record<string, unknown>;
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
      lark: {
        enabled: bool(c.lark?.enabled),
        webhookUrl: str(c.lark?.webhookUrl),
      },
      msteams: {
        enabled: bool(c.msteams?.enabled),
        webhookUrl: str(c.msteams?.webhookUrl),
      },
      mattermost: {
        enabled: bool(c.mattermost?.enabled),
        webhookUrl: str(c.mattermost?.webhookUrl),
      },
      gotify: {
        enabled: bool(c.gotify?.enabled),
        url: str(c.gotify?.url),
        tokenSet: false,
      },
      ntfy: {
        enabled: bool(c.ntfy?.enabled),
        baseUrl: str(c.ntfy?.baseUrl) || "https://ntfy.sh",
        topic: str(c.ntfy?.topic),
        tokenSet: false,
      },
      pushover: {
        enabled: bool(c.pushover?.enabled),
        tokenSet: false,
        userKeySet: false,
      },
    },
    alerts: Object.fromEntries(
      ALL_CHANNELS.map((channel) => {
        const raw = rawAlerts[channel];
        const wanted = new Set(Array.isArray(raw) ? (raw as unknown[]) : []);
        return [channel, ALL_ALERTS.filter((a) => wanted.has(a))];
      }),
    ) as ChannelAlerts,
    secrets: {
      smtpPassword: str(secrets.smtpPassword),
      resendApiKey: str(secrets.resendApiKey),
      telegramBotToken: str(secrets.telegramBotToken),
      gotifyToken: str(secrets.gotifyToken),
      ntfyToken: str(secrets.ntfyToken),
      pushoverToken: str(secrets.pushoverToken),
      pushoverUserKey: str(secrets.pushoverUserKey),
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

  // Every URL here is dialed FROM the control plane (test send + alert dispatch)
  // — reject private/internal targets before they are ever persisted, so no
  // dispatcher can be fed one (SSRF). That includes the Gotify and ntfy server
  // addresses, which is why a self-hosted one on the LAN is refused.
  for (const [url, label] of [
    [c.discord.webhookUrl, "Discord webhook URL"],
    [c.slack.webhookUrl, "Slack webhook URL"],
    [c.webhook.url, "Webhook URL"],
    [c.lark.webhookUrl, "Lark webhook URL"],
    [c.msteams.webhookUrl, "Microsoft Teams webhook URL"],
    [c.mattermost.webhookUrl, "Mattermost webhook URL"],
    [c.gotify.url, "Gotify server URL"],
    [c.ntfy.baseUrl, "ntfy server URL"],
  ] as const)
    if (url) await assertSafeOutboundUrl(url, label);

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
    gotifyTokenEnc: keep(next.secrets?.gotifyToken, prev?.gotifyTokenEnc),
    ntfyTokenEnc: keep(next.secrets?.ntfyToken, prev?.ntfyTokenEnc),
    pushoverTokenEnc: keep(next.secrets?.pushoverToken, prev?.pushoverTokenEnc),
    pushoverUserKeyEnc: keep(
      next.secrets?.pushoverUserKey,
      prev?.pushoverUserKeyEnc,
    ),
  });

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
      ALL_CHANNELS.flatMap((channel) => {
        const on = new Set(next.alerts[channel]);
        return ALL_ALERTS.map((a) => ({
          teamId,
          channel,
          alertKey: a,
          enabled: on.has(a),
        }));
      }),
    );
  });

  return { channels: rowToChannels(row), alerts: next.alerts };
}

/* ------------------------------------------------------------------ */
/* The dispatcher's read (UNGATED, background-safe)                    */
/* ------------------------------------------------------------------ */

/**
 * The configured channels that want `key`, resolved WITHOUT a request.
 *
 * Deliberately ungated and `teamId`-by-parameter, like `recordServerHealth` and
 * `executeBackup`: most alerts are raised by a deploy runner, a scheduler tick
 * or a telemetry stream, none of which has an active team or a user. It is
 * INTERNAL — never exported through GraphQL, never called from a resolver;
 * `getNotificationSettings()` stays the only request-facing read, with both
 * gates on it. Nothing here reads or writes anything a user could target.
 *
 * A channel with no stored row for `key` falls back to the catalog default,
 * which is what makes a newly enabled channel start on the defaults.
 *
 * Returns plaintext credentials, so it must never reach a DTO.
 */
export async function channelsForAlert(
  teamId: string,
  key: AlertKey,
): Promise<AlertChannel[]> {
  const [row, alerts] = await Promise.all([
    settingsRowFor(teamId),
    alertsFor(teamId),
  ]);
  if (!row) return [];
  // `AlertChannel["kind"]` IS `NotificationChannel` — same spellings, on purpose.
  return configuredChannels(row).filter((c) => alerts[c.kind].includes(key));
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
  if (row.larkEnabled && row.larkWebhookUrl)
    out.push({ kind: "lark", webhookUrl: row.larkWebhookUrl });
  if (row.msteamsEnabled && row.msteamsWebhookUrl)
    out.push({ kind: "msteams", webhookUrl: row.msteamsWebhookUrl });
  if (row.mattermostEnabled && row.mattermostWebhookUrl)
    out.push({ kind: "mattermost", webhookUrl: row.mattermostWebhookUrl });
  if (row.gotifyEnabled && row.gotifyUrl && row.gotifyTokenEnc)
    out.push({
      kind: "gotify",
      url: row.gotifyUrl,
      token: decryptSecret(row.gotifyTokenEnc),
    });
  if (row.ntfyEnabled && row.ntfyBaseUrl && row.ntfyTopic)
    out.push({
      kind: "ntfy",
      baseUrl: row.ntfyBaseUrl,
      topic: row.ntfyTopic,
      // A public topic needs no token, so an empty one is a valid config.
      token: row.ntfyTokenEnc ? decryptSecret(row.ntfyTokenEnc) : "",
    });
  if (row.pushoverEnabled && row.pushoverTokenEnc && row.pushoverUserKeyEnc)
    out.push({
      kind: "pushover",
      token: decryptSecret(row.pushoverTokenEnc),
      userKey: decryptSecret(row.pushoverUserKeyEnc),
    });
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
    case "lark":
      if (!row.larkWebhookUrl) throw new Error("Add a Lark webhook URL first");
      return { kind: "lark", webhookUrl: row.larkWebhookUrl };
    case "msteams":
      if (!row.msteamsWebhookUrl)
        throw new Error("Add a Microsoft Teams webhook URL first");
      return { kind: "msteams", webhookUrl: row.msteamsWebhookUrl };
    case "mattermost":
      if (!row.mattermostWebhookUrl)
        throw new Error("Add a Mattermost webhook URL first");
      return { kind: "mattermost", webhookUrl: row.mattermostWebhookUrl };
    case "gotify":
      if (!row.gotifyUrl || !row.gotifyTokenEnc)
        throw new Error("Add a Gotify server URL and app token first");
      return {
        kind: "gotify",
        url: row.gotifyUrl,
        token: decryptSecret(row.gotifyTokenEnc),
      };
    case "ntfy":
      if (!row.ntfyBaseUrl || !row.ntfyTopic)
        throw new Error("Add an ntfy server URL and topic first");
      return {
        kind: "ntfy",
        baseUrl: row.ntfyBaseUrl,
        topic: row.ntfyTopic,
        token: row.ntfyTokenEnc ? decryptSecret(row.ntfyTokenEnc) : "",
      };
    case "pushover":
      if (!row.pushoverTokenEnc || !row.pushoverUserKeyEnc)
        throw new Error("Add a Pushover application token and user key first");
      return {
        kind: "pushover",
        token: decryptSecret(row.pushoverTokenEnc),
        userKey: decryptSecret(row.pushoverUserKeyEnc),
      };
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

