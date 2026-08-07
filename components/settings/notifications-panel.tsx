"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Bell,
  Copy,
  Mail,
  Megaphone,
  MessageSquare,
  MonitorSmartphone,
  Radio,
  Send,
  Smartphone,
  Users,
  Webhook,
} from "lucide-react";

import { AlertPicker } from "@/components/settings/alert-picker";
import {
  DiscordIcon,
  MattermostIcon,
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { gqlAction } from "@/lib/graphql-client";
import { ALL_ALERTS, ALL_CHANNELS } from "@/lib/types";
import type {
  AlertKey,
  ChannelAlerts,
  NotificationChannel,
  NotificationSettings,
  NotificationSettingsInput,
} from "@/lib/types";

/** How each channel names itself in the sheet title. */
const CHANNEL_LABEL: Record<NotificationChannel, string> = {
  push: "Browser push",
  email: "Email",
  discord: "Discord",
  webhook: "Webhook",
  slack: "Slack",
  telegram: "Telegram",
  lark: "Lark",
  msteams: "Microsoft Teams",
  gotify: "Gotify",
  ntfy: "ntfy",
  mattermost: "Mattermost",
  pushover: "Pushover",
};

/** The plaintext credentials the user retyped this session; empty = keep stored. */
type Secrets = NonNullable<NotificationSettingsInput["secrets"]>;

export function NotificationsPanel({
  initial,
  vapidPublicKey,
  canManage,
}: {
  initial: NotificationSettings;
  vapidPublicKey: string;
  /** Cosmetic: the real gate is `manage_notifications` in the data layer. */
  canManage: boolean;
}) {
  const router = useRouter();
  const [settings, setSettings] = React.useState<NotificationSettings>(initial);
  const [secrets, setSecrets] = React.useState<Secrets>({});
  const [saving, startSave] = React.useTransition();
  const [testing, setTesting] = React.useState<string | null>(null);
  /** Which channel's alert sheet is open. One sheet, one picker, ever. */
  const [openFor, setOpenFor] = React.useState<NotificationChannel | null>(null);

  const channels = settings.channels;

  function setChannelAlerts(channel: NotificationChannel, next: AlertKey[]) {
    setSettings((s) => ({ ...s, alerts: { ...s.alerts, [channel]: next } }));
  }

  function copyToEveryChannel(from: NotificationChannel) {
    setSettings((s) => ({
      ...s,
      alerts: Object.fromEntries(
        ALL_CHANNELS.map((c) => [c, [...s.alerts[from]]]),
      ) as ChannelAlerts,
    }));
    toast.success("Copied to every channel");
  }

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
            <InfoTip content="Where alerts go. Each channel carries its own list of what it is told about." />
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
            alertCount={settings.alerts.email.length}
            onOpenAlerts={() => setOpenFor("email")}
            readOnly={!canManage}
            testDisabled={!channels.email.enabled || !emailReady || !canManage}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Send alerts to">
                <Input
                  disabled={!canManage}
                  type="email"
                  value={channels.email.address}
                  onChange={(e) => patchEmail({ address: e.target.value })}
                  placeholder="alerts@example.com"
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="Transport">
                <Select
                  disabled={!canManage}
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
                  disabled={!canManage}
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
                      disabled={!canManage}
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
                      disabled={!canManage}
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
                      disabled={!canManage}
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
                      disabled={!canManage}
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
                    disabled={!canManage}
                    type="password"
                    value={secrets.resendApiKey ?? ""}
                    onChange={(e) =>
                      setSecrets((s) => ({ ...s, resendApiKey: e.target.value }))
                    }
                    autoComplete="off"
                    placeholder={
                      channels.email.resend.apiKeySet
                        ? "Stored - leave blank to keep it"
                        : "Your Resend API key"
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
            alertCount={settings.alerts.discord.length}
            onOpenAlerts={() => setOpenFor("discord")}
            readOnly={!canManage}
            testDisabled={!channels.discord.enabled || !channels.discord.webhookUrl || !canManage}
          >
            <Input
              disabled={!canManage}
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
            alertCount={settings.alerts.slack.length}
            onOpenAlerts={() => setOpenFor("slack")}
            readOnly={!canManage}
            testDisabled={!channels.slack.enabled || !channels.slack.webhookUrl || !canManage}
          >
            <Input
              disabled={!canManage}
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
            alertCount={settings.alerts.telegram.length}
            onOpenAlerts={() => setOpenFor("telegram")}
            readOnly={!canManage}
            testDisabled={
              !channels.telegram.enabled ||
              !channels.telegram.chatId ||
              !(channels.telegram.botTokenSet || secrets.telegramBotToken) ||
              !canManage
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Bot token">
                <Input
                  disabled={!canManage}
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
                  disabled={!canManage}
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
            alertCount={settings.alerts.webhook.length}
            onOpenAlerts={() => setOpenFor("webhook")}
            readOnly={!canManage}
            testDisabled={!channels.webhook.enabled || !channels.webhook.url || !canManage}
          >
            <Input
              disabled={!canManage}
              value={channels.webhook.url}
              onChange={(e) => patchChannel("webhook", { url: e.target.value })}
              placeholder="https://example.com/hooks/deplo"
              className="font-mono text-sm"
            />
          </ChannelRow>

          <ChannelRow
            icon={<MessageSquare className="size-4" />}
            title="Lark"
            beta
            description="Posts into a group through a custom bot."
            enabled={channels.lark.enabled}
            onToggle={(on) => patchChannel("lark", { enabled: on })}
            onTest={() => testChannel("lark")}
            testing={testing === "lark"}
            alertCount={settings.alerts.lark.length}
            onOpenAlerts={() => setOpenFor("lark")}
            readOnly={!canManage}
            testDisabled={
              !channels.lark.enabled || !channels.lark.webhookUrl || !canManage
            }
          >
            <Input
              disabled={!canManage}
              value={channels.lark.webhookUrl}
              onChange={(e) => patchChannel("lark", { webhookUrl: e.target.value })}
              placeholder="https://open.larksuite.com/open-apis/bot/v2/hook/"
              className="font-mono text-sm"
            />
          </ChannelRow>

          <ChannelRow
            icon={<Users className="size-4" />}
            title="Microsoft Teams"
            beta
            description="Posts into a channel through a Power Automate workflow."
            enabled={channels.msteams.enabled}
            onToggle={(on) => patchChannel("msteams", { enabled: on })}
            onTest={() => testChannel("msteams")}
            testing={testing === "msteams"}
            alertCount={settings.alerts.msteams.length}
            onOpenAlerts={() => setOpenFor("msteams")}
            readOnly={!canManage}
            testDisabled={
              !channels.msteams.enabled ||
              !channels.msteams.webhookUrl ||
              !canManage
            }
          >
            <Input
              disabled={!canManage}
              value={channels.msteams.webhookUrl}
              onChange={(e) =>
                patchChannel("msteams", { webhookUrl: e.target.value })
              }
              placeholder="https://prod-00.westeurope.logic.azure.com/workflows/"
              className="font-mono text-sm"
            />
          </ChannelRow>

          <ChannelRow
            icon={<MattermostIcon className="size-4" />}
            title="Mattermost"
            beta
            description="Posts into a channel through an incoming webhook."
            enabled={channels.mattermost.enabled}
            onToggle={(on) => patchChannel("mattermost", { enabled: on })}
            onTest={() => testChannel("mattermost")}
            testing={testing === "mattermost"}
            alertCount={settings.alerts.mattermost.length}
            onOpenAlerts={() => setOpenFor("mattermost")}
            readOnly={!canManage}
            testDisabled={
              !channels.mattermost.enabled ||
              !channels.mattermost.webhookUrl ||
              !canManage
            }
          >
            <Input
              disabled={!canManage}
              value={channels.mattermost.webhookUrl}
              onChange={(e) =>
                patchChannel("mattermost", { webhookUrl: e.target.value })
              }
              placeholder="https://mattermost.example.com/hooks/"
              className="font-mono text-sm"
            />
          </ChannelRow>

          <ChannelRow
            icon={<Radio className="size-4" />}
            title="Gotify"
            beta
            description="Pushes to your own Gotify server."
            enabled={channels.gotify.enabled}
            onToggle={(on) => patchChannel("gotify", { enabled: on })}
            onTest={() => testChannel("gotify")}
            testing={testing === "gotify"}
            alertCount={settings.alerts.gotify.length}
            onOpenAlerts={() => setOpenFor("gotify")}
            readOnly={!canManage}
            testDisabled={
              !channels.gotify.enabled ||
              !channels.gotify.url ||
              !(channels.gotify.tokenSet || secrets.gotifyToken) ||
              !canManage
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Server URL">
                <Input
                  disabled={!canManage}
                  value={channels.gotify.url}
                  onChange={(e) => patchChannel("gotify", { url: e.target.value })}
                  placeholder="https://gotify.example.com"
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="Application token">
                <Input
                  disabled={!canManage}
                  type="password"
                  value={secrets.gotifyToken ?? ""}
                  onChange={(e) =>
                    setSecrets((s) => ({ ...s, gotifyToken: e.target.value }))
                  }
                  autoComplete="off"
                  placeholder={
                    channels.gotify.tokenSet
                      ? "Stored - leave blank to keep it"
                      : "Your Gotify application token"
                  }
                  className="font-mono text-sm"
                />
              </Field>
            </div>
          </ChannelRow>

          <ChannelRow
            icon={<Megaphone className="size-4" />}
            title="ntfy"
            beta
            description="Publishes to a topic on ntfy.sh or your own server."
            enabled={channels.ntfy.enabled}
            onToggle={(on) => patchChannel("ntfy", { enabled: on })}
            onTest={() => testChannel("ntfy")}
            testing={testing === "ntfy"}
            alertCount={settings.alerts.ntfy.length}
            onOpenAlerts={() => setOpenFor("ntfy")}
            readOnly={!canManage}
            testDisabled={
              !channels.ntfy.enabled ||
              !channels.ntfy.baseUrl ||
              !channels.ntfy.topic ||
              !canManage
            }
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Server URL">
                <Input
                  disabled={!canManage}
                  value={channels.ntfy.baseUrl}
                  onChange={(e) => patchChannel("ntfy", { baseUrl: e.target.value })}
                  placeholder="https://ntfy.sh"
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="Topic">
                <Input
                  disabled={!canManage}
                  value={channels.ntfy.topic}
                  onChange={(e) => patchChannel("ntfy", { topic: e.target.value })}
                  placeholder="deplo-alerts"
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="Access token">
                <Input
                  disabled={!canManage}
                  type="password"
                  value={secrets.ntfyToken ?? ""}
                  onChange={(e) =>
                    setSecrets((s) => ({ ...s, ntfyToken: e.target.value }))
                  }
                  autoComplete="off"
                  placeholder={
                    channels.ntfy.tokenSet
                      ? "Stored - leave blank to keep it"
                      : "Only for a protected topic"
                  }
                  className="font-mono text-sm"
                />
              </Field>
            </div>
          </ChannelRow>

          <ChannelRow
            icon={<Smartphone className="size-4" />}
            title="Pushover"
            beta
            description="Pushes to your phone through Pushover."
            enabled={channels.pushover.enabled}
            onToggle={(on) => patchChannel("pushover", { enabled: on })}
            onTest={() => testChannel("pushover")}
            testing={testing === "pushover"}
            alertCount={settings.alerts.pushover.length}
            onOpenAlerts={() => setOpenFor("pushover")}
            readOnly={!canManage}
            testDisabled={
              !channels.pushover.enabled ||
              !(channels.pushover.tokenSet || secrets.pushoverToken) ||
              !(channels.pushover.userKeySet || secrets.pushoverUserKey) ||
              !canManage
            }
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Application token">
                <Input
                  disabled={!canManage}
                  type="password"
                  value={secrets.pushoverToken ?? ""}
                  onChange={(e) =>
                    setSecrets((s) => ({ ...s, pushoverToken: e.target.value }))
                  }
                  autoComplete="off"
                  placeholder={
                    channels.pushover.tokenSet
                      ? "Stored - leave blank to keep it"
                      : "Your Pushover application token"
                  }
                  className="font-mono text-sm"
                />
              </Field>
              <Field label="User or group key">
                <Input
                  disabled={!canManage}
                  type="password"
                  value={secrets.pushoverUserKey ?? ""}
                  onChange={(e) =>
                    setSecrets((s) => ({ ...s, pushoverUserKey: e.target.value }))
                  }
                  autoComplete="off"
                  placeholder={
                    channels.pushover.userKeySet
                      ? "Stored - leave blank to keep it"
                      : "Your user or group key"
                  }
                  className="font-mono text-sm"
                />
              </Field>
            </div>
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
            alertCount={settings.alerts.push.length}
            onOpenAlerts={() => setOpenFor("push")}
            readOnly={!canManage}
            testDisabled={!channels.push.enabled || !canManage}
          />
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving || !canManage}>
          {saving ? "Saving" : "Save preferences"}
        </Button>
      </div>

      {/* ONE sheet for whichever channel is open, so only one picker is ever
          mounted - which is also what keeps its per-row DOM ids unique. */}
      <Sheet
        open={openFor !== null}
        onOpenChange={(open) => !open && setOpenFor(null)}
      >
        <SheetContent
          side="right"
          className="flex h-full w-full flex-col sm:max-w-xl"
        >
          {openFor && (
            <>
              <div className="border-b border-border p-4">
                <SheetTitle>{CHANNEL_LABEL[openFor]} alerts</SheetTitle>
                <SheetDescription className="mt-1">
                  What this channel is told about. Every channel has its own list.
                </SheetDescription>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <AlertPicker
                  alerts={settings.alerts[openFor]}
                  disabled={!canManage}
                  onChange={(next) => setChannelAlerts(openFor, next)}
                />
              </div>
              <div className="flex items-center gap-1.5 border-t border-border p-4">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canManage}
                  onClick={() => copyToEveryChannel(openFor)}
                >
                  <Copy className="size-3.5" />
                  Copy to every channel
                </Button>
                <InfoTip content="Replaces every other channel's list with this one. Nothing changes until you save." />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
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
  alertCount,
  onOpenAlerts,
  readOnly,
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
  /** How many alerts THIS channel is subscribed to. */
  alertCount?: number;
  onOpenAlerts?: () => void;
  /** Cosmetic read-only: the real gate is server-side. */
  readOnly?: boolean;
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
        <Switch
          checked={enabled}
          disabled={readOnly}
          onCheckedChange={onToggle}
        />
      </div>
      {enabled && (children || onOpenAlerts) && (
        <div className="mt-3 space-y-3 pl-11">
          {onOpenAlerts && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenAlerts}
            >
              <Bell className="size-3.5" />
              Alerts: {alertCount} of {ALL_ALERTS.length}
            </Button>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
