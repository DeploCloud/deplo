import "server-only";

import { ALERT_CATEGORIES, ALERT_META } from "../alerts";
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

/**
 * A configured destination, ready to dial. Secrets are already decrypted by the
 * caller.
 *
 * This describes the DIAL, not the stored instance, and carries no instance id
 * on purpose: nothing downstream of the dial needs one. The alert filter runs
 * upstream, on the row, precisely BECAUSE `kind` is the same answer for two
 * Discord rooms with different selections.
 */
export type AlertChannel =
  | { kind: "discord"; webhookUrl: string }
  | { kind: "slack"; webhookUrl: string }
  | { kind: "telegram"; botToken: string; chatId: string }
  | { kind: "webhook"; url: string }
  | { kind: "email"; to: string; config: EmailConfig }
  /** Endpoints are per user and resolved at send time from `push_subscriptions`. */
  | { kind: "push"; teamId: string; userId?: string }
  /* ---- beta ---- */
  | { kind: "lark"; webhookUrl: string }
  | { kind: "msteams"; webhookUrl: string }
  | { kind: "mattermost"; webhookUrl: string }
  | { kind: "gotify"; url: string; token: string }
  | { kind: "ntfy"; baseUrl: string; topic: string; token: string }
  | { kind: "pushover"; token: string; userKey: string };

/**
 * How long one channel gets before the others stop waiting for it.
 *
 * It lives HERE, next to the dials it bounds, rather than in the dispatcher:
 * `sendTestNotification` needs the same deadline, and `lib/data/notifications.ts`
 * importing the dispatcher would close a cycle (dispatch → channelsForAlert →
 * dispatch). Re-exported from `dispatch.ts`, which is where it reads best.
 */
export const CHANNEL_TIMEOUT_MS = 5_000;

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

    // No signal: `web-push` takes none. It bounds itself with its own socket
    // timeout instead — see `PUSH_TIMEOUT_MS`.
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

    // The Power Automate Workflows template Microsoft tells people to create
    // posts `text`. An Adaptive Card envelope only renders if the workflow was
    // built to post a card, which that template is not.
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

    // The token goes in a header, not `?token=`: a query string lands in every
    // access log on the way.
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
        { "X-Gotify-Key": channel.token },
      );
      return;

    // The topic rides in the BODY, so the dial is the bare server address.
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
        channel.token ? { Authorization: `Bearer ${channel.token}` } : undefined,
      );
      return;

    // A fixed host with the credentials in the BODY: nothing user-supplied in
    // the URL, so there is nothing for the guard to check and nothing to
    // redirect to. Same reasoning as Telegram above.
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
      // This switch is `async`, so falling off the end is legal TypeScript and a
      // channel with no case would be a silent no-op — a switch that promises an
      // alert and delivers silence, which is the exact bug this feature exists
      // to close. The `never` makes it a compile error instead.
      const unreachable: never = channel;
      throw new Error(`No sender for channel ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The dashboard link, on its own line, only when there is one. */
function linkLine(msg: AlertMessage): string {
  return msg.url ? `\n${msg.url}` : "";
}

/* ---------------------------------------------------------------- Discord -- */

/**
 * Discord gets a real embed, not a line of bold text: a colour stripe that says
 * at a glance whether this is bad news, the catalog's own name for the event,
 * and the dashboard link on the title. Every string in it is one Deplo already
 * shows on the notification settings page — the channel is a view of the same
 * catalog, not a second vocabulary.
 *
 * No images: the embed renders on Discord's side, so a logo would have to be
 * fetched from the panel's address, which on a private instance is unreachable
 * and draws a broken thumbnail.
 */
function discordPayload(msg: AlertMessage) {
  return {
    embeds: [
      {
        author: { name: `Deplo · ${categoryLabel(msg.key)}` },
        title: msg.title,
        // Omitted when the panel address is unknown: a title link to a bare
        // path is a dead link.
        ...(msg.url ? { url: msg.url } : {}),
        description: msg.body,
        color: embedColor(msg.key),
        fields: [
          { name: "Event", value: ALERT_META[msg.key].label, inline: true },
        ],
        // Rendered by Discord in the reader's own timezone.
        timestamp: msg.ts,
      },
    ],
  };
}

/** Which section of the notification settings this alert is browsed under. */
function categoryLabel(key: AlertKey): string {
  return (
    ALERT_CATEGORIES.find((c) => c.alerts.includes(key))?.label ?? "Alerts"
  );
}

/** The `--destructive` / `--success` / `--warning` / `--info` dark tokens. */
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
