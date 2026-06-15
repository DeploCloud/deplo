import "server-only";

import { read, mutate } from "../store";
import { assertUser } from "../auth";
import type { NotificationChannel, NotificationSettings } from "../types";

/** Default config, also used to backfill stores seeded before this feature. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  channels: {
    push: { enabled: false },
    email: { enabled: false, address: "" },
    discord: { enabled: false, webhookUrl: "" },
    webhook: { enabled: false, url: "" },
  },
  events: {
    deployment_failed: true,
    deployment_succeeded: false,
    server_offline: true,
    high_resource_usage: true,
    update_available: true,
  },
};

export async function getNotificationSettings(): Promise<NotificationSettings> {
  await assertUser();
  const existing = read().notificationSettings;
  if (existing) return existing;
  // Backfill stores created before notifications existed.
  return mutate((d) => {
    d.notificationSettings ??= DEFAULT_NOTIFICATION_SETTINGS;
    return d.notificationSettings;
  });
}

export async function updateNotificationSettings(
  next: NotificationSettings,
): Promise<NotificationSettings> {
  await assertUser();
  return mutate((d) => {
    d.notificationSettings = next;
    return d.notificationSettings;
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
  await assertUser();
  const c = read().notificationSettings?.channels ??
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
