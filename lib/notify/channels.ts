import "server-only";

import { ALERT_CATEGORIES, ALERT_META } from "../alerts";
import { assertSafeOutboundUrl } from "../outbound-url";
import { sendEmail, type EmailConfig } from "./email";
import { sendWebPushTo } from "./web-push";
import type { AlertKey } from "../types/notification";

export type AlertChannel =
  | { kind: "discord"; webhookUrl: string }
  | { kind: "slack"; webhookUrl: string }
  | { kind: "telegram"; botToken: string; chatId: string }
  | { kind: "webhook"; url: string }
  | { kind: "email"; to: string; config: EmailConfig }
  | { kind: "push"; teamId: string; userId?: string }
  | { kind: "lark"; webhookUrl: string }
  | { kind: "msteams"; webhookUrl: string }
  | { kind: "mattermost"; webhookUrl: string }
  | { kind: "gotify"; url: string; token: string }
  | { kind: "ntfy"; baseUrl: string; topic: string; token: string }
  | { kind: "pushover"; token: string; userKey: string };

export const CHANNEL_TIMEOUT_MS = 5_000;

export interface AlertMessage {
  key: AlertKey;
  title: string;
  body: string;
  url: string | null;
  ts: string;
}

export async function sendToChannel(
  channel: AlertChannel,
  msg: AlertMessage,
  signal?: AbortSignal,
): Promise<void> {
  switch (channel.kind) {
    case "discord":
      await postJson(
        channel.webhookUrl,
        "Discord webhook URL",
        discordPayload(msg),
        signal,
      );
      return;

    case "slack":
      await postJson(
        channel.webhookUrl,
        "Slack webhook URL",
        { text: `*${msg.title}*\n${msg.body}${linkLine(msg)}` },
        signal,
      );
      return;

    case "telegram": {
      const res = await fetch(
        `https://api.telegram.org/bot${channel.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: channel.chatId,
            text: `${msg.title}\n${msg.body}${linkLine(msg)}`,
            disable_web_page_preview: true,
          }),
          redirect: "manual",
          signal,
        },
      );
      if (!res.ok) throw new Error(await telegramError(res));
      return;
    }

    case "webhook":
      await postJson(
        channel.url,
        "Webhook URL",
        {
          event: msg.key,
          title: msg.title,
          body: msg.body,
          url: msg.url,
          ts: msg.ts,
        },
        signal,
      );
      return;

    case "email":
      await sendEmail(
        channel.config,
        {
          to: channel.to,
          subject: msg.title,
          text: `${msg.body}${linkLine(msg)}`,
        },
        signal,
      );
      return;

    case "push":
      await sendWebPushTo(channel.teamId, channel.userId ?? null, msg);
      return;

    case "lark":
      await postJson(
        channel.webhookUrl,
        "Lark webhook URL",
        {
          msg_type: "text",
          content: { text: `${msg.title}\n${msg.body}${linkLine(msg)}` },
        },
        signal,
      );
      return;

    case "msteams":
      await postJson(
        channel.webhookUrl,
        "Microsoft Teams webhook URL",
        { text: `**${msg.title}**\n\n${msg.body}${linkLine(msg)}` },
        signal,
      );
      return;

    case "mattermost":
      await postJson(
        channel.webhookUrl,
        "Mattermost webhook URL",
        { text: `**${msg.title}**\n${msg.body}${linkLine(msg)}` },
        signal,
      );
      return;

    case "gotify":
      await postJson(
        `${channel.url.replace(/\/+$/, "")}/message`,
        "Gotify server URL",
        {
          title: msg.title,
          message: `${msg.body}${linkLine(msg)}`,
          priority: 5,
        },
        signal,
        // In a header, never ?token=: a query string lands in every access log on the way.
        { "X-Gotify-Key": channel.token },
      );
      return;

    case "ntfy":
      await postJson(
        channel.baseUrl,
        "ntfy server URL",
        {
          topic: channel.topic,
          title: msg.title,
          message: msg.body,
          priority: 4,
          ...(msg.url ? { click: msg.url } : {}),
        },
        signal,
        channel.token
          ? { Authorization: `Bearer ${channel.token}` }
          : undefined,
      );
      return;

    case "pushover": {
      const res = await fetch("https://api.pushover.net/1/messages.json", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token: channel.token,
          user: channel.userKey,
          title: msg.title,
          message: msg.body,
          ...(msg.url ? { url: msg.url } : {}),
        }),
        redirect: "manual",
        signal,
      });
      if (!res.ok) throw new Error(`Pushover returned ${res.status}`);
      return;
    }

    default: {
      const unreachable: never = channel;
      throw new Error(`No sender for channel ${JSON.stringify(unreachable)}`);
    }
  }
}

function linkLine(msg: AlertMessage): string {
  return msg.url ? `\n${msg.url}` : "";
}

function discordPayload(msg: AlertMessage) {
  return {
    embeds: [
      {
        author: { name: `Deplo · ${categoryLabel(msg.key)}` },
        title: msg.title,
        ...(msg.url ? { url: msg.url } : {}),
        description: msg.body,
        color: embedColor(msg.key),
        fields: [
          { name: "Event", value: ALERT_META[msg.key].label, inline: true },
        ],
        timestamp: msg.ts,
      },
    ],
  };
}

function categoryLabel(key: AlertKey): string {
  return (
    ALERT_CATEGORIES.find((c) => c.alerts.includes(key))?.label ?? "Alerts"
  );
}

const DANGER = new Set<AlertKey>([
  "app_crash_loop",
  "server_offline",
  "server_unmanageable",
  "server_trust_changed",
  "git_connection_failing",
  "failed_logins",
]);
const GOOD = new Set<AlertKey>(["server_online", "database_ready"]);
const WARN = new Set<AlertKey>([
  "deployment_interrupted",
  "database_rebuilt",
  "database_deleted",
  "server_resources_high",
  "server_disk_low",
  "certificate_expiring",
  "domain_dns_drift",
  "teardown_abandoned",
  "git_access_missing",
]);

function embedColor(key: AlertKey): number {
  if (key.endsWith("_failed") || DANGER.has(key)) return 0xff5c5c;
  if (key.endsWith("_succeeded") || GOOD.has(key)) return 0x50e3c2;
  if (WARN.has(key)) return 0xf5a623;
  return 0x5b9dff;
}

async function postJson(
  url: string,
  label: string,
  body: unknown,
  signal?: AbortSignal,
  headers?: Record<string, string>,
): Promise<void> {
  await assertSafeOutboundUrl(url, label);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    redirect: "manual",
    signal,
  });
  if (!res.ok)
    throw new Error(`${label.replace(/ URL$/, "")} returned ${res.status}`);
}

async function telegramError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { description?: string };
    if (body.description) return body.description;
  } catch {}
  return `Telegram returned ${res.status}`;
}
