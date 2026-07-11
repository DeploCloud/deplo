"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, Mail, Webhook, MonitorSmartphone, Send } from "lucide-react";
import { DiscordIcon } from "@/components/shared/brand-icons";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import type { NotificationEvent, NotificationSettings } from "@/lib/types";

const EVENT_LABELS: Record<NotificationEvent, string> = {
  deployment_failed: "Deployment failed",
  deployment_succeeded: "Deployment succeeded",
  server_offline: "Server went offline",
  high_resource_usage: "High CPU / memory / disk usage",
  update_available: "New Deplo version available",
};

const EVENT_ORDER: NotificationEvent[] = [
  "deployment_failed",
  "server_offline",
  "high_resource_usage",
  "deployment_succeeded",
  "update_available",
];

export function NotificationsPanel({
  initial,
}: {
  initial: NotificationSettings;
}) {
  const router = useRouter();
  const [settings, setSettings] = React.useState<NotificationSettings>(initial);
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

  function toggleEvent(event: NotificationEvent, on: boolean) {
    setSettings((s) => ({ ...s, events: { ...s.events, [event]: on } }));
  }

  function save() {
    startSave(async () => {
      const res = await gqlAction(
        `mutation($input: JSON!) { saveNotificationSettings(input: $input) { __typename } }`,
        { input: settings },
      );
      if (res.ok) {
        toast.success("Notification settings saved");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  async function testServerChannel(channel: "email" | "discord" | "webhook") {
    setTesting(channel);
    try {
      const res = await gqlAction(
        `mutation($channel: TestNotificationChannel!) { testNotification(channel: $channel) }`,
        { channel },
      );
      if (res.ok) toast.success(`Test alert sent via ${channel}`);
      else toast.error(res.error);
    } finally {
      setTesting(null);
    }
  }

  async function testPush() {
    if (typeof window === "undefined" || !("Notification" in window)) {
      toast.error("This browser does not support notifications");
      return;
    }
    setTesting("push");
    try {
      let permission = Notification.permission;
      if (permission === "default") permission = await Notification.requestPermission();
      if (permission !== "granted") {
        toast.error("Notification permission denied");
        patchChannel("push", { enabled: false });
        return;
      }
      new Notification("Deplo test alert", {
        body: "Browser push is wired up correctly.",
      });
      toast.success("Push notification sent");
    } finally {
      setTesting(null);
    }
  }

  async function onTogglePush(on: boolean) {
    if (on && "Notification" in window) {
      let permission = Notification.permission;
      if (permission === "default") permission = await Notification.requestPermission();
      if (permission !== "granted") {
        // Controlled Switch is bound to state, so leaving it unset keeps it off.
        toast.error("Notification permission denied");
        return;
      }
    }
    patchChannel("push", { enabled: on });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            <Bell className="size-4" />
            Alert channels
            <InfoTip content="Get notified about anomalies and important events through one or more channels." />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Browser push */}
          <ChannelRow
            icon={<MonitorSmartphone className="size-4" />}
            title="Browser push"
            description="Desktop notifications in this browser."
            titleInfo="Requires this browser's permission to show notifications, and only alerts this browser on this device."
            enabled={channels.push.enabled}
            onToggle={onTogglePush}
            onTest={testPush}
            testing={testing === "push"}
            testDisabled={!channels.push.enabled}
          />

          {/* Email */}
          <ChannelRow
            icon={<Mail className="size-4" />}
            title="Email"
            description="Send alerts to an inbox."
            enabled={channels.email.enabled}
            onToggle={(on) => patchChannel("email", { enabled: on })}
            onTest={() => testServerChannel("email")}
            testing={testing === "email"}
            testDisabled={!channels.email.enabled || !channels.email.address}
          >
            <Input
              type="email"
              value={channels.email.address}
              onChange={(e) => patchChannel("email", { address: e.target.value })}
              placeholder="alerts@example.com"
              className="font-mono text-sm"
            />
          </ChannelRow>

          {/* Discord webhook */}
          <ChannelRow
            icon={<DiscordIcon className="size-4" />}
            title="Discord"
            description="Post alerts to a channel via a Discord webhook."
            enabled={channels.discord.enabled}
            onToggle={(on) => patchChannel("discord", { enabled: on })}
            onTest={() => testServerChannel("discord")}
            testing={testing === "discord"}
            testDisabled={!channels.discord.enabled || !channels.discord.webhookUrl}
          >
            <Input
              value={channels.discord.webhookUrl}
              onChange={(e) =>
                patchChannel("discord", { webhookUrl: e.target.value })
              }
              placeholder="https://discord.com/api/webhooks/..."
              className="font-mono text-sm"
            />
          </ChannelRow>

          {/* Generic webhook */}
          <ChannelRow
            icon={<Webhook className="size-4" />}
            title="Webhook"
            description="POST a JSON payload to any endpoint."
            enabled={channels.webhook.enabled}
            onToggle={(on) => patchChannel("webhook", { enabled: on })}
            onTest={() => testServerChannel("webhook")}
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
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            Alert on
            <InfoTip content="Which conditions trigger an alert across your enabled channels." />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {EVENT_ORDER.map((event) => (
            <label
              key={event}
              className="flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-1 py-2 hover:border-border hover:bg-accent/40"
            >
              <Checkbox
                checked={settings.events[event]}
                onCheckedChange={(v) => toggleEvent(event, v === true)}
              />
              <span className="text-sm">{EVENT_LABELS[event]}</span>
            </label>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save preferences"}
        </Button>
      </div>
    </div>
  );
}

function ChannelRow({
  icon,
  title,
  titleInfo,
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
            {titleInfo != null && <InfoTip content={titleInfo} />}
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onTest}
          disabled={testDisabled || testing}
        >
          <Send className="size-3.5" />
          {testing ? "Sending…" : "Test"}
        </Button>
        <Switch checked={enabled} onCheckedChange={onToggle} />
      </div>
      {enabled && children && (
        <div className="mt-3 pl-11">
          <Label className="sr-only">{title} target</Label>
          {children}
        </div>
      )}
    </div>
  );
}
