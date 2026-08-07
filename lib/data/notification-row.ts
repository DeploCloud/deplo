import type { InferSelectModel } from "drizzle-orm";

import { notificationSettings } from "../db/schema/control-plane";
import type { EmailProvider, NotificationSettings } from "../types";

/**
 * The ONE flat-columns ↔ nested-object mapping for `notification_settings`,
 * shared by every reader and writer in the data layer (`lib/data/notifications.ts`)
 * so reads and writes can't drift. Pure — no `server-only`, no store, no db
 * handle, and no crypto: the ciphertext is resolved by the caller (which is the
 * only place that can apply the "empty means keep the stored one" rule) and
 * handed in already encrypted.
 *
 * Only the CHANNELS live in this row. The subscribed alerts are a list and live
 * in `notification_alerts`; see `lib/data/notifications.ts`.
 *
 * The DTO never carries a secret in either direction: a stored credential
 * surfaces as a `…Set: boolean`, which is the one bit the UI needs and cannot
 * leak a length. There is no reveal path, by design.
 */

export type NotificationRow = InferSelectModel<typeof notificationSettings>;

/** The ciphertext for a write, already resolved (new value or the stored one). */
export interface ChannelSecretsEnc {
  smtpPasswordEnc: string;
  resendApiKeyEnc: string;
  telegramBotTokenEnc: string;
  gotifyTokenEnc: string;
  ntfyTokenEnc: string;
  pushoverTokenEnc: string;
  pushoverUserKeyEnc: string;
}

/** Reassemble a flat `notification_settings` row into the DTO's channel map. */
export function rowToChannels(
  row: NotificationRow,
): NotificationSettings["channels"] {
  return {
    push: { enabled: row.pushEnabled },
    email: {
      enabled: row.emailEnabled,
      address: row.emailAddress,
      from: row.emailFrom,
      provider: (row.emailProvider === "smtp" ? "smtp" : "resend") as EmailProvider,
      smtp: {
        host: row.smtpHost,
        port: row.smtpPort,
        user: row.smtpUser,
        passwordSet: row.smtpPasswordEnc !== "",
      },
      resend: { apiKeySet: row.resendApiKeyEnc !== "" },
    },
    discord: { enabled: row.discordEnabled, webhookUrl: row.discordWebhookUrl },
    slack: { enabled: row.slackEnabled, webhookUrl: row.slackWebhookUrl },
    telegram: {
      enabled: row.telegramEnabled,
      chatId: row.telegramChatId,
      botTokenSet: row.telegramBotTokenEnc !== "",
    },
    webhook: { enabled: row.webhookEnabled, url: row.webhookUrl },
    lark: { enabled: row.larkEnabled, webhookUrl: row.larkWebhookUrl },
    msteams: { enabled: row.msteamsEnabled, webhookUrl: row.msteamsWebhookUrl },
    gotify: {
      enabled: row.gotifyEnabled,
      url: row.gotifyUrl,
      tokenSet: row.gotifyTokenEnc !== "",
    },
    ntfy: {
      enabled: row.ntfyEnabled,
      baseUrl: row.ntfyBaseUrl,
      topic: row.ntfyTopic,
      tokenSet: row.ntfyTokenEnc !== "",
    },
    mattermost: {
      enabled: row.mattermostEnabled,
      webhookUrl: row.mattermostWebhookUrl,
    },
    pushover: {
      enabled: row.pushoverEnabled,
      tokenSet: row.pushoverTokenEnc !== "",
      userKeySet: row.pushoverUserKeyEnc !== "",
    },
  };
}

/**
 * Explode the DTO's channel map into its flat `notification_settings` row.
 * Returns the SELECT shape (every column set), so the caller can both insert it
 * and hand it straight back to `rowToChannels` for the response.
 */
export function channelsToRow(
  teamId: string,
  c: NotificationSettings["channels"],
  enc: ChannelSecretsEnc,
): NotificationRow {
  return {
    teamId,
    pushEnabled: c.push.enabled,
    emailEnabled: c.email.enabled,
    emailAddress: c.email.address,
    emailFrom: c.email.from,
    emailProvider: c.email.provider,
    smtpHost: c.email.smtp.host,
    smtpPort: c.email.smtp.port,
    smtpUser: c.email.smtp.user,
    smtpPasswordEnc: enc.smtpPasswordEnc,
    resendApiKeyEnc: enc.resendApiKeyEnc,
    discordEnabled: c.discord.enabled,
    discordWebhookUrl: c.discord.webhookUrl,
    slackEnabled: c.slack.enabled,
    slackWebhookUrl: c.slack.webhookUrl,
    telegramEnabled: c.telegram.enabled,
    telegramBotTokenEnc: enc.telegramBotTokenEnc,
    telegramChatId: c.telegram.chatId,
    webhookEnabled: c.webhook.enabled,
    webhookUrl: c.webhook.url,
    larkEnabled: c.lark.enabled,
    larkWebhookUrl: c.lark.webhookUrl,
    msteamsEnabled: c.msteams.enabled,
    msteamsWebhookUrl: c.msteams.webhookUrl,
    mattermostEnabled: c.mattermost.enabled,
    mattermostWebhookUrl: c.mattermost.webhookUrl,
    gotifyEnabled: c.gotify.enabled,
    gotifyUrl: c.gotify.url,
    gotifyTokenEnc: enc.gotifyTokenEnc,
    ntfyEnabled: c.ntfy.enabled,
    ntfyBaseUrl: c.ntfy.baseUrl,
    ntfyTopic: c.ntfy.topic,
    ntfyTokenEnc: enc.ntfyTokenEnc,
    pushoverEnabled: c.pushover.enabled,
    pushoverTokenEnc: enc.pushoverTokenEnc,
    pushoverUserKeyEnc: enc.pushoverUserKeyEnc,
  };
}
