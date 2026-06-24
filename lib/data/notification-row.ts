import type { InferInsertModel, InferSelectModel } from "drizzle-orm";

import { notificationSettings } from "../db/schema/control-plane";
import type { NotificationEvent, NotificationSettings } from "../types";

/**
 * The ONE flat-columns ↔ nested-object mapping for `notification_settings`
 * (relational-store PLAN §2 "notification_settings"), shared by every reader and
 * writer in the data layer (`lib/data/notifications.ts`) so reads and writes can't
 * drift. Pure — no `server-only`, no store, no db handle — so a `server-only`
 * module can import it freely.
 *
 * The relational table flattens the `{channels, events}` object into one boolean/
 * text column per field (no JSONB map). `settingsToRow` explodes the object into
 * columns; `rowToSettings` reassembles it. The `EVENT_COLUMNS` table below is
 * declared `satisfies Record<NotificationEvent, …>`, so adding a new event to the
 * union fails to compile until it is mapped here — a settings event can never be
 * silently dropped on either path (PLAN §7 "exhaustive … coverage").
 */

type NotificationRow = InferSelectModel<typeof notificationSettings>;
type NotificationInsert = InferInsertModel<typeof notificationSettings>;

/**
 * Each {@link NotificationEvent} ↔ its flat column name. The single source of
 * truth for the event mapping, exhaustiveness-checked at compile time.
 */
const EVENT_COLUMNS = {
  deployment_failed: "deploymentFailed",
  deployment_succeeded: "deploymentSucceeded",
  server_offline: "serverOffline",
  high_resource_usage: "highResourceUsage",
  update_available: "updateAvailable",
} as const satisfies Record<NotificationEvent, keyof NotificationRow>;

/** Explode a {@link NotificationSettings} into its flat `notification_settings` row. */
export function settingsToRow(
  teamId: string,
  s: NotificationSettings,
): NotificationInsert {
  return {
    teamId,
    pushEnabled: s.channels.push.enabled,
    emailEnabled: s.channels.email.enabled,
    emailAddress: s.channels.email.address,
    discordEnabled: s.channels.discord.enabled,
    discordWebhookUrl: s.channels.discord.webhookUrl,
    webhookEnabled: s.channels.webhook.enabled,
    webhookUrl: s.channels.webhook.url,
    deploymentFailed: s.events.deployment_failed,
    deploymentSucceeded: s.events.deployment_succeeded,
    serverOffline: s.events.server_offline,
    highResourceUsage: s.events.high_resource_usage,
    updateAvailable: s.events.update_available,
  };
}

/** Reassemble a flat `notification_settings` row into a {@link NotificationSettings}. */
export function rowToSettings(row: NotificationRow): NotificationSettings {
  const events = {} as Record<NotificationEvent, boolean>;
  for (const event of Object.keys(EVENT_COLUMNS) as NotificationEvent[]) {
    events[event] = row[EVENT_COLUMNS[event]];
  }
  return {
    channels: {
      push: { enabled: row.pushEnabled },
      email: { enabled: row.emailEnabled, address: row.emailAddress },
      discord: { enabled: row.discordEnabled, webhookUrl: row.discordWebhookUrl },
      webhook: { enabled: row.webhookEnabled, url: row.webhookUrl },
    },
    events,
  };
}
