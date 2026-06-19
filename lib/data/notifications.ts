import "server-only";

import { read, mutate } from "../store";
import { requireActiveTeamId, requireCapability } from "../membership";
import { defaultNotificationSettings } from "../types";
import type { NotificationChannel, NotificationSettings } from "../types";

/** Default config, also used to backfill stores seeded before this feature. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings =
  defaultNotificationSettings();

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const teamId = await requireActiveTeamId();
  return read().notificationSettings[teamId] ?? defaultNotificationSettings();
}

export async function updateNotificationSettings(
  next: NotificationSettings,
): Promise<NotificationSettings> {
  // Notifications are an infra-level team setting.
  const teamId = (await requireCapability("manage_infra")).teamId;
  return mutate((d) => {
    d.notificationSettings[teamId] = next;
    return d.notificationSettings[teamId];
  });
}

/**
 * Deliver a one-off test alert through a single channel using the saved config.
 * Discord and the generic webhook perform a real outbound POST; email is
 * accepted (no SMTP transport is bundled in this build). Browser push is
 * delivered from the client and is not handled here.
 */
export async function sendTestNotification(
  channel: Exclude<NotificationChannel, "push">,
): Promise<void> {
  // Sending a real outbound POST is a side-effecting infra action — gate it the
  // same way as editing the settings, so a view-only member can't drive traffic
  // to the team's configured Discord/webhook endpoints.
  const teamId = (await requireCapability("manage_infra")).teamId;
  const c =
    read().notificationSettings[teamId]?.channels ??
    DEFAULT_NOTIFICATION_SETTINGS.channels;

  const title = "Deplo test alert";
  const body = "This channel is wired up correctly.";

  if (channel === "discord") {
    if (!c.discord.webhookUrl) throw new Error("Add a Discord webhook URL first");
    const res = await fetch(c.discord.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: `**${title}**\n${body}` }),
    });
    if (!res.ok) throw new Error(`Discord webhook returned ${res.status}`);
    return;
  }

  if (channel === "webhook") {
    if (!c.webhook.url) throw new Error("Add a webhook URL first");
    const res = await fetch(c.webhook.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "test",
        title,
        body,
        ts: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
    return;
  }

  // email
  if (!c.email.address) throw new Error("Add an email address first");
  // No SMTP transport is bundled; a real deployment wires this to a provider.
}
