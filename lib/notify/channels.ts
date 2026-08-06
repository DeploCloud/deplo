import "server-only";

import { assertSafeOutboundUrl } from "../outbound-url";
import { sendEmail, type EmailConfig } from "./email";
import { sendWebPushTo } from "./web-push";
import type { AlertKey } from "../types";

/**
 * One channel, one message, one place. Both the dispatcher (a real alert) and
 * the settings page (the Test button) go through `sendToChannel`, so the
 * Discord/Slack/Telegram/webhook POSTs exist exactly once and a fix to one is a
 * fix to both.
 *
 * Every user-supplied URL is re-checked with `assertSafeOutboundUrl` HERE, at
 * the dial, and every dial sets `redirect: "manual"` — the save-time check ran
 * on a different day (and rows predate the guard entirely), and a 302 is the
 * other way out of a checked URL. The control plane dials these from a
 * background loop with no user behind it, which is exactly the shape SSRF wants.
 *
 * Throws on failure with the provider's own words; the dispatcher catches per
 * channel so one dead webhook never costs the others.
 */

/** A configured destination. Secrets are already decrypted by the caller. */
export type AlertChannel =
  | { kind: "discord"; webhookUrl: string }
  | { kind: "slack"; webhookUrl: string }
  | { kind: "telegram"; botToken: string; chatId: string }
  | { kind: "webhook"; url: string }
  | { kind: "email"; to: string; config: EmailConfig }
  /** Endpoints are per user and resolved at send time from `push_subscriptions`. */
  | { kind: "push"; teamId: string; userId?: string };

export interface AlertMessage {
  key: AlertKey;
  /** One line, plain text. */
  title: string;
  /** One or two lines. */
  body: string;
  /** Absolute dashboard link, or null when the panel URL isn't known. */
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
        { content: `**${msg.title}**\n${msg.body}${linkLine(msg)}` },
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
      // A fixed host with the token in the path: nothing user-supplied to check,
      // and nothing to redirect to.
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
      await sendEmail(channel.config, {
        to: channel.to,
        subject: msg.title,
        text: `${msg.body}${linkLine(msg)}`,
      });
      return;

    case "push":
      await sendWebPushTo(channel.teamId, channel.userId ?? null, msg);
      return;
  }
}

/** The dashboard link, on its own line, only when there is one. */
function linkLine(msg: AlertMessage): string {
  return msg.url ? `\n${msg.url}` : "";
}

async function postJson(
  url: string,
  label: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<void> {
  await assertSafeOutboundUrl(url, label);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    redirect: "manual",
    signal,
  });
  if (!res.ok) throw new Error(`${label.replace(/ URL$/, "")} returned ${res.status}`);
}

/** Telegram answers a bad token or chat id with a readable `description`. */
async function telegramError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { description?: string };
    if (body.description) return body.description;
  } catch {
    // Not JSON — fall through to the status.
  }
  return `Telegram returned ${res.status}`;
}
