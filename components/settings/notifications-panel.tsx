"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, Mail, Webhook, MonitorSmartphone, Send } from "lucide-react";

import { AlertPicker } from "@/components/settings/alert-picker";
import {
  DiscordIcon,
  SlackIcon,
  TelegramIcon,
} from "@/components/shared/brand-icons";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { gqlAction } from "@/lib/graphql-client";
import type {
  NotificationSettings,
  NotificationSettingsInput,
} from "@/lib/types";

/** The plaintext credentials the user retyped this session; empty = keep stored. */
type Secrets = NonNullable<NotificationSettingsInput["secrets"]>;

export function NotificationsPanel({
  initial,
  vapidPublicKey,
}: {
  initial: NotificationSettings;
  vapidPublicKey: string;
}) {
  const router = useRouter();
  const [settings, setSettings] = React.useState<NotificationSettings>(initial);
  const [secrets, setSecrets] = React.useState<Secrets>({});
  const [saving, startSave] = React.useTransition();
  const [testing, setTesting] = React.useState<string | null>(null);

  const channels = settings.channels;

  function patchChannel<K extends keyof NotificationSettings["channels"]>(
    key: K,
    value: Partial<NotificationSettings["channels"][K]>,
  ) {
    setSettings((s) => ({
      ...s,
      channels: { ...s.channels, [key]: { ...s.channels[key], ...value } },
    }));
  }

  function patchEmail(value: Partial<NotificationSettings["channels"]["email"]>) {
    patchChannel("email", value);
  }

  function save() {
    startSave(async () => {
      const res = await gqlAction(
        `mutation($input: JSON!) { saveNotificationSettings(input: $input) { __typename } }`,
        { input: { ...settings, secrets } },
      );
      if (res.ok) {
        toast.success("Notification settings saved");
        setSecrets({});
        router.refresh();
      } else toast.error(res.error);
    });
  }

  async function testChannel(channel: string) {
    setTesting(channel);
    try {
      const res = await gqlAction(
        `mutation($channel: TestNotificationChannel!) { testNotification(channel: $channel) }`,
        { channel },
      );
      if (res.ok) toast.success("Test alert sent");
      else toast.error(res.error);
    } finally {
      setTesting(null);
    }
  }

  /* ---- Browser push (beta) -------------------------------------------- */

  async function togglePush(on: boolean) {
    if (!on) {
      await unsubscribeThisBrowser();
      patchChannel("push", { enabled: false });
      return;
    }
    // A service worker needs a secure context. Say so instead of failing with a
    // browser console message nobody will read.
    if (
      typeof window === "undefined" ||
      !("serviceWorker" in navigator) ||
      !("PushManager" in window) ||
      !window.isSecureContext
    ) {
      toast.error("Browser push needs this panel to be served over https");
      return;
    }
    if ((await Notification.requestPermission()) !== "granted") {
      toast.error("Your browser blocked notifications for this site");
      return;
    }
    try {
      const reg = await navigator.serviceWorker.register("/sw.js");
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidPublicKey,
      });
      const json = sub.toJSON();
      const res = await gqlAction(
        `mutation($endpoint: String!, $p256dh: String!, $auth: String!) {
           subscribeWebPush(endpoint: $endpoint, p256dh: $p256dh, auth: $auth)
         }`,
        {
          endpoint: sub.endpoint,
          p256dh: json.keys?.p256dh ?? "",
          auth: json.keys?.auth ?? "",
        },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      patchChannel("push", { enabled: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function unsubscribeThisBrowser() {
    try {
      const reg = await navigator.serviceWorker?.getRegistration("/sw.js");
      const sub = await reg?.pushManager.getSubscription();
      if (!sub) return;
      await sub.unsubscribe();
      await gqlAction(
        `mutation($endpoint: String!) { unsubscribeWebPush(endpoint: $endpoint) }`,
        { endpoint: sub.endpoint },
      );
    } catch {
      // Nothing registered on this device, which is the state we wanted anyway.
    }
  }

  const smtp = channels.email.provider === "smtp";
  const emailReady = smtp
    ? channels.email.address !== "" && channels.email.smtp.host !== ""
    : channels.email.address !== "" &&
      (channels.email.resend.apiKeySet || (secrets.resendApiKey ?? "") !== "");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <Bell className="size-4" />
            Alert channels
            <InfoTip content="Where alerts go. Every alert you subscribe to below is sent to every channel you switch on here." />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ChannelRow
            icon={<Mail className="size-4" />}
            title="Email"
            description="Delivered through your own SMTP server or a Resend key."
            enabled={channels.email.enabled}
            onToggle={(on) => patchEmail({ enabled: on })}
            onTest={() => testChannel("email")}
            testing={testing === "email"}
            testDisabled={!channels.email.enabled || !emailReady}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Send alerts to">
                <Input
                  type="email"
                  value={channels.email.address}
                  onChange={(e) => patchEmail({ address: e.target.value })}
                  placeholder="alerts@example.com"
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="Transport">
                <Select
                  value={channels.email.provider}
                  onValueChange={(v) =>
                    patchEmail({ provider: v as "smtp" | "resend" })
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
              <Field label="From address">
                <Input
                  type="email"
                  value={channels.email.from}
                  onChange={(e) => patchEmail({ from: e.target.value })}
                  placeholder="deplo@example.com"
                  className="font-mono text-sm"
                />
              </Field>
              {smtp ? (
                <>
                  <Field label="SMTP host">
                    <Input
                      value={channels.email.smtp.host}
                      onChange={(e) =>
                        patchEmail({
                          smtp: { ...channels.email.smtp, host: e.target.value },
                        })
                      }
                      placeholder="smtp.example.com"
                      className="font-mono text-sm"
                    />
                  </Field>
                  <Field label="Port">
                    <Input
                      type="number"
                      value={channels.email.smtp.port}
                      onChange={(e) =>
                        patchEmail({
                          smtp: {
                            ...channels.email.smtp,
                            port: Number(e.target.value) || 587,
                          },
                        })
                      }
                      className="font-mono text-sm"
                    />
                  </Field>
                  <Field label="Username">
                    <Input
                      value={channels.email.smtp.user}
                      onChange={(e) =>
                        patchEmail({
                          smtp: { ...channels.email.smtp, user: e.target.value },
                        })
                      }
                      autoComplete="off"
                      className="font-mono text-sm"
                    />
                  </Field>
                  <Field label="Password">
                    <Input
                      type="password"
                      value={secrets.smtpPassword ?? ""}
                      onChange={(e) =>
                        setSecrets((s) => ({ ...s, smtpPassword: e.target.value }))
                      }
                      autoComplete="new-password"
                      placeholder={
                        channels.email.smtp.passwordSet
                          ? "Stored - leave blank to keep it"
                          : "Your SMTP password"
                      }
                      className="font-mono text-sm"
                    />
                  </Field>
                </>
              ) : (
                <Field label="Resend API key">
                  <Input
                    type="password"
                    value={secrets.resendApiKey ?? ""}
                    onChange={(e) =>
                      setSecrets((s) => ({ ...s, resendApiKey: e.target.value }))
                    }
                    autoComplete="off"
                    placeholder={
                      channels.email.resend.apiKeySet
                        ? "Stored - leave blank to keep it"
                        : "re_..."
                    }
                    className="font-mono text-sm"
                  />
                </Field>
              )}
            </div>
          </ChannelRow>

          <ChannelRow
            icon={<DiscordIcon className="size-4" />}
            title="Discord"
            description="Posts into a channel through an incoming webhook."
            enabled={channels.discord.enabled}
            onToggle={(on) => patchChannel("discord", { enabled: on })}
            onTest={() => testChannel("discord")}
            testing={testing === "discord"}
            testDisabled={!channels.discord.enabled || !channels.discord.webhookUrl}
          >
            <Input
              value={channels.discord.webhookUrl}
              onChange={(e) =>
                patchChannel("discord", { webhookUrl: e.target.value })
              }
              placeholder="https://discord.com/api/webhooks/"
              className="font-mono text-sm"
            />
          </ChannelRow>

          <ChannelRow
            icon={<SlackIcon className="size-4" />}
            title="Slack"
            beta
            description="Posts into a channel through an incoming webhook."
            enabled={channels.slack.enabled}
            onToggle={(on) => patchChannel("slack", { enabled: on })}
            onTest={() => testChannel("slack")}
            testing={testing === "slack"}
            testDisabled={!channels.slack.enabled || !channels.slack.webhookUrl}
          >
            <Input
              value={channels.slack.webhookUrl}
              onChange={(e) =>
                patchChannel("slack", { webhookUrl: e.target.value })
              }
              placeholder="https://hooks.slack.com/services/"
              className="font-mono text-sm"
            />
          </ChannelRow>

          <ChannelRow
            icon={<TelegramIcon className="size-4" />}
            title="Telegram"
            beta
            description="Sends to a chat through a bot you created with BotFather."
            enabled={channels.telegram.enabled}
            onToggle={(on) => patchChannel("telegram", { enabled: on })}
            onTest={() => testChannel("telegram")}
            testing={testing === "telegram"}
            testDisabled={
              !channels.telegram.enabled ||
              !channels.telegram.chatId ||
              !(channels.telegram.botTokenSet || secrets.telegramBotToken)
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Bot token">
                <Input
                  type="password"
                  value={secrets.telegramBotToken ?? ""}
                  onChange={(e) =>
                    setSecrets((s) => ({
                      ...s,
                      telegramBotToken: e.target.value,
                    }))
                  }
                  autoComplete="off"
                  placeholder={
                    channels.telegram.botTokenSet
                      ? "Stored - leave blank to keep it"
                      : "123456:ABC-DEF"
                  }
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="Chat id">
                <Input
                  value={channels.telegram.chatId}
                  onChange={(e) =>
                    patchChannel("telegram", { chatId: e.target.value })
                  }
                  placeholder="-1001234567890"
                  className="font-mono text-sm"
                />
              </Field>
            </div>
          </ChannelRow>

          <ChannelRow
            icon={<Webhook className="size-4" />}
            title="Webhook"
            description="POSTs a small JSON body to any URL you own."
            enabled={channels.webhook.enabled}
            onToggle={(on) => patchChannel("webhook", { enabled: on })}
            onTest={() => testChannel("webhook")}
            testing={testing === "webhook"}
            testDisabled={!channels.webhook.enabled || !channels.webhook.url}
          >
            <Input
              value={channels.webhook.url}
              onChange={(e) => patchChannel("webhook", { url: e.target.value })}
              placeholder="https://example.com/hooks/deplo"
              className="font-mono text-sm"
            />
          </ChannelRow>

          <ChannelRow
            icon={<MonitorSmartphone className="size-4" />}
            title="Browser push"
            beta
            titleInfo="Alerts arrive on this device even when the dashboard is closed. Turn it on once per browser."
            description="Desktop notifications on the devices you turn it on for."
            enabled={channels.push.enabled}
            onToggle={togglePush}
            onTest={() => testChannel("push")}
            testing={testing === "push"}
            testDisabled={!channels.push.enabled}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <AlertPicker
            alerts={settings.alerts}
            onChange={(alerts) => setSettings((s) => ({ ...s, alerts }))}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving" : "Save preferences"}
        </Button>
      </div>
    </div>
  );
}

/** One labelled input inside a channel's expanded body. */
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

function ChannelRow({
  icon,
  title,
  titleInfo,
  beta,
  description,
  enabled,
  onToggle,
  onTest,
  testing,
  testDisabled,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  titleInfo?: React.ReactNode;
  beta?: boolean;
  description: string;
  enabled: boolean;
  onToggle: (on: boolean) => void;
  onTest: () => void;
  testing: boolean;
  testDisabled: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex w-fit items-center gap-1.5">
            <p className="text-sm font-medium">{title}</p>
            {beta && (
              <Badge variant="info" className="px-1.5 py-0 text-[10px]">
                Beta
              </Badge>
            )}
            {titleInfo != null && <InfoTip content={titleInfo} />}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onTest}
          disabled={testDisabled || testing}
        >
          <Send className="size-3.5" />
          {testing ? "Sending" : "Test"}
        </Button>
        <Switch checked={enabled} onCheckedChange={onToggle} />
      </div>
      {enabled && children && <div className="mt-3 pl-11">{children}</div>}
    </div>
  );
}
