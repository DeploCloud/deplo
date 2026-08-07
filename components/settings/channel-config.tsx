"use client";

import * as React from "react";
import { Bell } from "lucide-react";

import { CHANNEL_BRAND } from "@/components/settings/channel-brand";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  NotificationChannel,
  NotificationSettings,
  NotificationSettingsInput,
} from "@/lib/types";

/**
 * One channel's own fields — where to send, and what to send with.
 *
 * These used to sit inline under twelve stacked rows, which made the page a
 * wall of inputs before you had decided anything. They live in the channel's
 * sheet now, so the page itself carries no form at all.
 *
 * The plaintext credentials ride in their own bag and are write-only: a stored
 * one shows as a placeholder, never as a value, and leaving the field blank
 * keeps what is stored.
 */

export type Channels = NotificationSettings["channels"];
export type Secrets = NonNullable<NotificationSettingsInput["secrets"]>;

export interface ChannelConfigProps {
  channel: NotificationChannel;
  channels: Channels;
  secrets: Secrets;
  onPatch: <K extends keyof Channels>(
    key: K,
    value: Partial<Channels[K]>,
  ) => void;
  onSecret: (key: keyof Secrets, value: string) => void;
  readOnly: boolean;
}

/**
 * Whether this channel has everything it needs to actually send. Drives both
 * the tile's "Needs setup" line and the sheet's Test button, so the two can
 * never disagree.
 */
export function isChannelReady(
  channel: NotificationChannel,
  c: Channels,
  s: Secrets,
): boolean {
  const has = (stored: boolean, typed?: string) => stored || !!typed;
  switch (channel) {
    case "push":
      return true;
    case "email":
      return (
        !!c.email.address &&
        (c.email.provider === "smtp"
          ? !!c.email.smtp.host
          : has(c.email.resend.apiKeySet, s.resendApiKey))
      );
    case "discord":
      return !!c.discord.webhookUrl;
    case "slack":
      return !!c.slack.webhookUrl;
    case "telegram":
      return !!c.telegram.chatId && has(c.telegram.botTokenSet, s.telegramBotToken);
    case "webhook":
      return !!c.webhook.url;
    case "lark":
      return !!c.lark.webhookUrl;
    case "msteams":
      return !!c.msteams.webhookUrl;
    case "mattermost":
      return !!c.mattermost.webhookUrl;
    case "gotify":
      return !!c.gotify.url && has(c.gotify.tokenSet, s.gotifyToken);
    case "ntfy":
      return !!c.ntfy.baseUrl && !!c.ntfy.topic;
    case "pushover":
      return (
        has(c.pushover.tokenSet, s.pushoverToken) &&
        has(c.pushover.userKeySet, s.pushoverUserKey)
      );
  }
}

export function ChannelConfig(props: ChannelConfigProps) {
  const { channel, channels: c, secrets: s, onPatch, onSecret, readOnly } = props;
  const text = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    placeholder: string,
  ) => (
    <Field label={label}>
      <Input
        value={value}
        disabled={readOnly}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="font-mono text-sm"
      />
    </Field>
  );
  const secret = (
    label: string,
    key: keyof Secrets,
    stored: boolean,
    placeholder: string,
  ) => (
    <Field label={label}>
      <Input
        type="password"
        value={s[key] ?? ""}
        disabled={readOnly}
        onChange={(e) => onSecret(key, e.target.value)}
        autoComplete="off"
        placeholder={stored ? "Stored - leave blank to keep it" : placeholder}
        className="font-mono text-sm"
      />
    </Field>
  );

  switch (channel) {
    case "push": {
      // The one channel with no fields at all. A bare line of muted text in an
      // otherwise empty modal reads as something failing to load, so it wears
      // the channel's own colour and looks deliberate.
      const brand = CHANNEL_BRAND.push;
      return (
        <div
          className="flex items-start gap-3 rounded-lg border p-3"
          style={{
            backgroundColor: `color-mix(in oklab, ${brand.bg} 10%, transparent)`,
            borderColor: `color-mix(in oklab, ${brand.bg} 35%, transparent)`,
          }}
        >
          <Bell className="mt-0.5 size-4 shrink-0" style={{ color: brand.bg }} />
          <p className="text-sm leading-snug">
            Nothing to configure. Turning this on asks this browser for
            permission, once per device.
          </p>
        </div>
      );
    }

    case "email": {
      const smtp = c.email.provider === "smtp";
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text(
            "Send alerts to",
            c.email.address,
            (v) => onPatch("email", { address: v }),
            "alerts@example.com",
          )}
          <Field label="Transport">
            <Select
              disabled={readOnly}
              value={c.email.provider}
              onValueChange={(v) =>
                onPatch("email", { provider: v as "smtp" | "resend" })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="smtp">SMTP server</SelectItem>
                <SelectItem value="resend">Resend</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {text(
            "From address",
            c.email.from,
            (v) => onPatch("email", { from: v }),
            "deplo@example.com",
          )}
          {smtp ? (
            <>
              <Field label="SMTP host">
                <Input
                  value={c.email.smtp.host}
                  disabled={readOnly}
                  onChange={(e) =>
                    onPatch("email", {
                      smtp: { ...c.email.smtp, host: e.target.value },
                    })
                  }
                  placeholder="smtp.example.com"
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  value={c.email.smtp.port}
                  disabled={readOnly}
                  onChange={(e) =>
                    onPatch("email", {
                      smtp: {
                        ...c.email.smtp,
                        port: Number(e.target.value) || 587,
                      },
                    })
                  }
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="Username">
                <Input
                  value={c.email.smtp.user}
                  disabled={readOnly}
                  onChange={(e) =>
                    onPatch("email", {
                      smtp: { ...c.email.smtp, user: e.target.value },
                    })
                  }
                  autoComplete="off"
                  className="font-mono text-sm"
                />
              </Field>
              {secret(
                "Password",
                "smtpPassword",
                c.email.smtp.passwordSet,
                "Your SMTP password",
              )}
            </>
          ) : (
            secret(
              "Resend API key",
              "resendApiKey",
              c.email.resend.apiKeySet,
              "Your Resend API key",
            )
          )}
        </div>
      );
    }

    case "discord":
      return text(
        "Webhook URL",
        c.discord.webhookUrl,
        (v) => onPatch("discord", { webhookUrl: v }),
        "https://discord.com/api/webhooks/",
      );

    case "slack":
      return text(
        "Webhook URL",
        c.slack.webhookUrl,
        (v) => onPatch("slack", { webhookUrl: v }),
        "https://hooks.slack.com/services/",
      );

    case "webhook":
      return text(
        "URL",
        c.webhook.url,
        (v) => onPatch("webhook", { url: v }),
        "https://example.com/hooks/deplo",
      );

    case "lark":
      return text(
        "Webhook URL",
        c.lark.webhookUrl,
        (v) => onPatch("lark", { webhookUrl: v }),
        "https://open.larksuite.com/open-apis/bot/v2/hook/",
      );

    case "msteams":
      return text(
        "Workflow URL",
        c.msteams.webhookUrl,
        (v) => onPatch("msteams", { webhookUrl: v }),
        "https://prod-00.westeurope.logic.azure.com/workflows/",
      );

    case "mattermost":
      return text(
        "Webhook URL",
        c.mattermost.webhookUrl,
        (v) => onPatch("mattermost", { webhookUrl: v }),
        "https://mattermost.example.com/hooks/",
      );

    case "telegram":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {secret(
            "Bot token",
            "telegramBotToken",
            c.telegram.botTokenSet,
            "123456:ABC-DEF",
          )}
          {text(
            "Chat id",
            c.telegram.chatId,
            (v) => onPatch("telegram", { chatId: v }),
            "-1001234567890",
          )}
        </div>
      );

    case "gotify":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text(
            "Server URL",
            c.gotify.url,
            (v) => onPatch("gotify", { url: v }),
            "https://gotify.example.com",
          )}
          {secret(
            "Application token",
            "gotifyToken",
            c.gotify.tokenSet,
            "Your Gotify application token",
          )}
        </div>
      );

    case "ntfy":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text(
            "Server URL",
            c.ntfy.baseUrl,
            (v) => onPatch("ntfy", { baseUrl: v }),
            "https://ntfy.sh",
          )}
          {text(
            "Topic",
            c.ntfy.topic,
            (v) => onPatch("ntfy", { topic: v }),
            "deplo-alerts",
          )}
          {secret(
            "Access token",
            "ntfyToken",
            c.ntfy.tokenSet,
            "Only for a protected topic",
          )}
        </div>
      );

    case "pushover":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {secret(
            "Application token",
            "pushoverToken",
            c.pushover.tokenSet,
            "Your Pushover application token",
          )}
          {secret(
            "User or group key",
            "pushoverUserKey",
            c.pushover.userKeySet,
            "Your user or group key",
          )}
        </div>
      );
  }
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
