"use client";

import * as React from "react";
import { Bell, Server } from "lucide-react";

import { CHANNEL_BRAND } from "@/components/settings/channel-brand";
import { ResendIcon } from "@/components/shared/brand-icons";
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
  NotificationChannelInput,
  NotificationChannelInstance,
} from "@/lib/types";

/**
 * One channel's own fields — where to send, and what to send with. These used to
 * sit inline under twelve stacked rows, which made the page a wall of inputs
 * before you had decided anything.
 */

export type Secrets = NonNullable<NotificationChannelInput["secrets"]>;
/** The instance being edited, before it has an id (creating) or after (editing). */
export type Draft = Omit<NotificationChannelInstance, "id">;

export interface ChannelConfigProps {
  draft: Draft;
  secrets: Secrets;
  onPatch: (value: Partial<Draft>) => void;
  onSecret: (key: keyof Secrets, value: string) => void;
  readOnly: boolean;
}

/**
 * Whether this channel has everything it needs to actually send. Drives both
 * the tile's "Needs setup" line and the sheet's Test button, so the two can
 * never disagree.
 */
export function isChannelReady(i: Draft, s: Secrets): boolean {
  const has = (stored: boolean, typed?: string) => stored || !!typed;
  switch (i.kind) {
    case "push":
      return true;
    case "email":
      return (
        !!i.target &&
        (i.emailProvider === "smtp"
          ? !!i.smtpHost
          : has(i.secret2Set, s.secret2))
      );
    case "discord":
    case "slack":
    case "webhook":
    case "lark":
    case "msteams":
    case "mattermost":
      return !!i.url;
    case "telegram":
      return !!i.target && has(i.secretSet, s.secret);
    case "gotify":
      return !!i.url && has(i.secretSet, s.secret);
    case "ntfy":
      return !!i.url && !!i.target;
    case "pushover":
      return has(i.secretSet, s.secret) && has(i.secret2Set, s.secret2);
  }
}

/**
 * The one line under a row's name: WHERE this channel sends. Pushover and browser
 * push have no address at all that is not a secret, so they show nothing and the
 * row leans on its status line instead.
 */
export function channelTarget(i: Draft): string {
  switch (i.kind) {
    case "push":
    case "pushover":
      return "";
    case "email":
    case "telegram":
      return i.target;
    case "gotify":
      return host(i.url);
    case "ntfy":
      return i.target ? `${host(i.url)}/${i.target}` : host(i.url);
    case "discord":
    case "slack":
    case "lark":
    case "mattermost":
    case "msteams":
    case "webhook":
      return trimSecret(i.url);
  }
}

/** Host only, and nothing at all for something that is not a URL yet. */
function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

/** Host and path minus the last segment — the token, on every brand here. */
function trimSecret(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean);
    return (
      u.host + (parts.length > 1 ? `/${parts.slice(0, -1).join("/")}` : "")
    );
  } catch {
    return "";
  }
}

export function ChannelConfig(props: ChannelConfigProps) {
  const { draft: i, secrets: s, onPatch, onSecret, readOnly } = props;
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
  /** Every webhook-shaped kind is one URL field; only the placeholder differs. */
  const webhook = (label: string, placeholder: string) =>
    text(label, i.url, (v) => onPatch({ url: v }), placeholder);

  switch (i.kind) {
    case "push": {
      // The one kind with no fields at all. A bare line of muted text in an
      // otherwise empty modal reads as something that failed to load, so it
      // wears the channel's own colour and looks deliberate.
      const brand = CHANNEL_BRAND.push;
      return (
        <div
          className="flex items-start gap-3 rounded-lg border p-3"
          style={{
            backgroundColor: `color-mix(in oklab, ${brand.bg} 10%, transparent)`,
            borderColor: `color-mix(in oklab, ${brand.bg} 35%, transparent)`,
          }}
        >
          <Bell
            className="mt-0.5 size-4 shrink-0"
            style={{ color: brand.bg }}
          />
          <p className="text-sm leading-snug">
            Nothing to configure. Turning this on asks this browser for
            permission, once per device.
          </p>
        </div>
      );
    }

    case "email": {
      const smtp = i.emailProvider === "smtp";
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text(
            "Send alerts to",
            i.target,
            (v) => onPatch({ target: v }),
            "alerts@example.com",
          )}
          <Field label="Transport">
            <Select
              disabled={readOnly}
              value={i.emailProvider}
              onValueChange={(v) =>
                onPatch({ emailProvider: v as "smtp" | "resend" })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              {/* Resend first: it is the default, and a list should open on it.
                  `SelectItem` wraps its children in Radix's `ItemText`, so the
                  mark rides along into the closed trigger for free. */}
              <SelectContent>
                <SelectItem value="resend">
                  <span className="flex items-center gap-2">
                    <ResendIcon className="size-3.5" />
                    Resend
                  </span>
                </SelectItem>
                <SelectItem value="smtp">
                  <span className="flex items-center gap-2">
                    <Server className="size-3.5 text-muted-foreground" />
                    SMTP server
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {text(
            "From address",
            i.emailFrom,
            (v) => onPatch({ emailFrom: v }),
            "deplo@example.com",
          )}
          {smtp ? (
            <>
              {text(
                "SMTP host",
                i.smtpHost,
                (v) => onPatch({ smtpHost: v }),
                "smtp.example.com",
              )}
              <Field label="Port">
                <Input
                  type="number"
                  value={i.smtpPort}
                  disabled={readOnly}
                  onChange={(e) =>
                    onPatch({ smtpPort: Number(e.target.value) || 587 })
                  }
                  className="font-mono text-sm"
                />
              </Field>
              {text(
                "Username",
                i.smtpUser,
                (v) => onPatch({ smtpUser: v }),
                "",
              )}
              {secret("Password", "secret", i.secretSet, "Your SMTP password")}
            </>
          ) : (
            secret(
              "Resend API key",
              "secret2",
              i.secret2Set,
              "Your Resend API key",
            )
          )}
        </div>
      );
    }

    case "discord":
      return webhook("Webhook URL", "https://discord.com/api/webhooks/");
    case "slack":
      return webhook("Webhook URL", "https://hooks.slack.com/services/");
    case "webhook":
      return webhook("URL", "https://example.com/hooks/deplo");
    case "lark":
      return webhook(
        "Webhook URL",
        "https://open.larksuite.com/open-apis/bot/v2/hook/",
      );
    case "msteams":
      return webhook(
        "Workflow URL",
        "https://prod-00.westeurope.logic.azure.com/workflows/",
      );
    case "mattermost":
      return webhook("Webhook URL", "https://mattermost.example.com/hooks/");

    case "telegram":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {secret("Bot token", "secret", i.secretSet, "123456:ABC-DEF")}
          {text(
            "Chat id",
            i.target,
            (v) => onPatch({ target: v }),
            "-1001234567890",
          )}
        </div>
      );

    case "gotify":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text(
            "Server URL",
            i.url,
            (v) => onPatch({ url: v }),
            "https://gotify.example.com",
          )}
          {secret(
            "Application token",
            "secret",
            i.secretSet,
            "Your Gotify application token",
          )}
        </div>
      );

    case "ntfy":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {text(
            "Server URL",
            i.url,
            (v) => onPatch({ url: v }),
            "https://ntfy.sh",
          )}
          {text(
            "Topic",
            i.target,
            (v) => onPatch({ target: v }),
            "deplo-alerts",
          )}
          {secret(
            "Access token",
            "secret",
            i.secretSet,
            "Only for a protected topic",
          )}
        </div>
      );

    case "pushover":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {secret(
            "Application token",
            "secret",
            i.secretSet,
            "Your Pushover application token",
          )}
          {secret(
            "User or group key",
            "secret2",
            i.secret2Set,
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
