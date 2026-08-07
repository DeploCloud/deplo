"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, Copy, Send } from "lucide-react";

import { AlertPicker } from "@/components/settings/alert-picker";
import {
  CHANNEL_BRAND,
  ChannelMark,
} from "@/components/settings/channel-brand";
import {
  ChannelConfig,
  isChannelReady,
  type Channels,
  type Secrets,
} from "@/components/settings/channel-config";
import { NotificationIllustration } from "@/components/settings/notification-illustration";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { gqlAction } from "@/lib/graphql-client";
import { ALL_ALERTS, ALL_CHANNELS } from "@/lib/types";
import type {
  AlertKey,
  ChannelAlerts,
  NotificationChannel,
  NotificationSettings,
} from "@/lib/types";

/**
 * The notification settings.
 *
 * The page is a GRID OF TWELVE TILES and nothing else. Every field, every
 * switch, every Test button and the 32-row alert picker live in one modal,
 * opened by the channel you clicked — because twelve channels, each with their
 * own credentials and their own alert list, laid out vertically, is several
 * screens of form on a page most people open to change one thing.
 *
 * A tile answers the only question the overview has to answer: is this on, and
 * how much is it told. Everything else is one click away.
 */
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
  const [testing, setTesting] = React.useState<NotificationChannel | null>(null);
  /** Which channel's modal is open. One modal, one alert picker, ever. */
  const [openFor, setOpenFor] = React.useState<NotificationChannel | null>(null);

  const channels = settings.channels;
  const onCount = ALL_CHANNELS.filter((c) => channels[c].enabled).length;

  function patchChannel<K extends keyof Channels>(
    key: K,
    value: Partial<Channels[K]>,
  ) {
    setSettings((s) => ({
      ...s,
      channels: { ...s.channels, [key]: { ...s.channels[key], ...value } },
    }));
  }

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

  async function testChannel(channel: NotificationChannel) {
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

  /**
   * Turning a channel on. Only browser push does anything beyond flipping the
   * flag: it has to ask this device for permission and register a worker, and
   * that has to succeed before the switch is allowed to look on.
   */
  async function toggleChannel(channel: NotificationChannel, on: boolean) {
    if (channel !== "push") {
      patchChannel(channel, { enabled: on } as Partial<Channels["discord"]>);
      return;
    }
    if (!on) {
      await unsubscribeThisBrowser();
      patchChannel("push", { enabled: false });
      return;
    }
    // A service worker needs a secure context. Say so, instead of failing with
    // a browser console message nobody will read.
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

  const open = openFor;
  const ready = open ? isChannelReady(open, channels, secrets) : false;

  return (
    <>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-1.5">
                <Bell className="size-4" />
                Alert channels
                <InfoTip content="Where alerts go. Each channel carries its own list of what it is told about." />
                <Badge
                  variant={onCount === 0 ? "muted" : "secondary"}
                  className="ml-auto tabular-nums"
                >
                  {onCount} on
                </Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-2 sm:grid-cols-2">
                {ALL_CHANNELS.map((channel) => (
                  <ChannelTile
                    key={channel}
                    channel={channel}
                    enabled={channels[channel].enabled}
                    ready={isChannelReady(channel, channels, secrets)}
                    alertCount={settings.alerts[channel].length}
                    onOpen={() => setOpenFor(channel)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="flex justify-end">
            <Button onClick={save} disabled={saving || !canManage}>
              {saving ? "Saving" : "Save preferences"}
            </Button>
          </div>
        </div>

        {/* Decoration, and the only thing on this page that says what it is FOR. */}
        <aside className="hidden xl:sticky xl:top-20 xl:block">
          <NotificationIllustration />
        </aside>
      </div>

      {/* ONE modal for whichever channel is open, so only one alert picker is
          ever mounted - which is also what keeps its per-row DOM ids unique.
          The alert list is far taller than any viewport, so the modal is capped
          and only its middle row scrolls: the channel stays named and its
          buttons stay reachable however far down the list you are. */}
      <Dialog
        open={open !== null}
        onOpenChange={(next) => !next && setOpenFor(null)}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl gap-0 p-0 grid-rows-[minmax(0,1fr)]">
          {open && (
            // A real form, so Enter in any field does the obvious thing instead
            // of nothing. There is no save here on purpose - the page's single
            // Save posts every channel at once - so the primary action is Done.
            <form
              className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                setOpenFor(null);
              }}
            >
              {/* pr-12 keeps the switch clear of the modal's own close button. */}
              <div className="flex items-start gap-3 border-b border-border p-4 pr-12">
                <ChannelMark channel={open} />
                <div className="min-w-0 flex-1">
                  <DialogTitle className="flex items-center gap-1.5">
                    {CHANNEL_BRAND[open].label}
                    {CHANNEL_BRAND[open].beta && (
                      <Badge variant="info" className="px-1.5 py-0 text-[10px]">
                        Beta
                      </Badge>
                    )}
                  </DialogTitle>
                  <DialogDescription className="mt-1">
                    {CHANNEL_BRAND[open].description}
                  </DialogDescription>
                </div>
                <Switch
                  checked={channels[open].enabled}
                  disabled={!canManage}
                  aria-label={`Turn ${CHANNEL_BRAND[open].label} on`}
                  onCheckedChange={(on) => void toggleChannel(open, on)}
                />
              </div>

              <div className="min-h-0 space-y-5 overflow-y-auto p-4">
                <ChannelConfig
                  channel={open}
                  channels={channels}
                  secrets={secrets}
                  onPatch={patchChannel}
                  onSecret={(key, value) =>
                    setSecrets((s) => ({ ...s, [key]: value }))
                  }
                  readOnly={!canManage}
                />
                <AlertPicker
                  alerts={settings.alerts[open]}
                  disabled={!canManage}
                  onChange={(next) => setChannelAlerts(open, next)}
                />
              </div>

              <DialogFooter className="items-center gap-1.5 border-t border-border p-4 sm:justify-between">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canManage || !channels[open].enabled || !ready}
                    onClick={() => void testChannel(open)}
                  >
                    <Send className="size-3.5" />
                    {testing === open ? "Sending" : "Send a test"}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={!canManage}
                    onClick={() => copyToEveryChannel(open)}
                  >
                    <Copy className="size-3.5" />
                    Copy alerts to every channel
                  </Button>
                  <InfoTip content="Replaces every other channel's list with this one. Nothing changes until you save." />
                </div>
                <Button type="submit" size="sm">
                  Done
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * One channel at a glance: its mark on its own colour, its name, and the one
 * line that says whether it is doing anything. The whole tile is the button.
 */
function ChannelTile({
  channel,
  enabled,
  ready,
  alertCount,
  onOpen,
}: {
  channel: NotificationChannel;
  enabled: boolean;
  ready: boolean;
  alertCount: number;
  onOpen: () => void;
}) {
  const brand = CHANNEL_BRAND[channel];
  const status = !enabled
    ? "Off"
    : !ready
      ? "Needs setup"
      : `${alertCount} of ${ALL_ALERTS.length} alerts`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex items-center gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:border-ring hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ChannelMark channel={channel} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{brand.label}</span>
          {brand.beta && (
            <Badge variant="info" className="px-1.5 py-0 text-[10px]">
              Beta
            </Badge>
          )}
        </span>
        <span
          className={
            enabled && !ready
              ? "mt-1 block text-xs text-[var(--warning)]"
              : "mt-1 block text-xs text-muted-foreground"
          }
        >
          {status}
        </span>
      </span>
      {/* The dot is the scannable "is this live" signal; the word backs it up. */}
      <span
        aria-hidden
        className="size-2 shrink-0 rounded-full"
        style={{
          backgroundColor: enabled && ready ? brand.bg : "transparent",
          boxShadow:
            enabled && ready ? undefined : "inset 0 0 0 1.5px var(--border)",
        }}
      />
    </button>
  );
}
