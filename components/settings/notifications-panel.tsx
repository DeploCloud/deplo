"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, Send } from "lucide-react";

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
  /**
   * What the settings looked like when the modal opened.
   *
   * It is what makes the modal's Save mean something: dismissing reverts to
   * this, so the only pending change when you press Save is the one you just
   * made. Without it, closing would leave edits floating with nowhere to go —
   * which is exactly what a page-level Save button did.
   */
  const [snapshot, setSnapshot] = React.useState<{
    settings: NotificationSettings;
    secrets: Secrets;
  } | null>(null);

  function openChannel(channel: NotificationChannel) {
    setSnapshot({ settings, secrets });
    setOpenFor(channel);
  }

  /** Dismissing is a cancel: put back what was there when the modal opened. */
  function closeChannel(revert: boolean) {
    if (revert && snapshot) {
      setSettings(snapshot.settings);
      setSecrets(snapshot.secrets);
    }
    setSnapshot(null);
    setOpenFor(null);
  }

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

  /**
   * Persist and close. The mutation replaces the whole settings document — that
   * is the API — but the snapshot above means the only thing that differs from
   * what the server already holds is what this modal changed, so "save" and
   * "save this channel" are the same act.
   */
  function saveChannel(channel: NotificationChannel) {
    startSave(async () => {
      const res = await gqlAction(
        `mutation($input: JSON!) { saveNotificationSettings(input: $input) { __typename } }`,
        { input: { ...settings, secrets } },
      );
      if (res.ok) {
        toast.success(`${CHANNEL_BRAND[channel].label} saved`);
        setSecrets({});
        setSnapshot(null);
        setOpenFor(null);
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
  // A test dials whatever the SERVER has stored, so testing an unsaved endpoint
  // would quietly exercise the old one. Save first, then test.
  const dirty =
    snapshot !== null &&
    (JSON.stringify(snapshot.settings) !== JSON.stringify(settings) ||
      JSON.stringify(snapshot.secrets) !== JSON.stringify(secrets));

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
                    onOpen={() => openChannel(channel)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Decoration, and the only thing on this page that says what it is FOR. */}
        <aside className="hidden xl:sticky xl:top-20 xl:block">
          <NotificationIllustration />
        </aside>
      </div>

      {/* ONE modal for whichever channel is open, so only one alert picker is
          ever mounted - which is also what keeps its per-row DOM ids unique.
          Its height is FIXED, not content-driven: the twelve channels range from
          no fields at all to six, and a modal that resized to each of them would
          jump every time you opened a different one. Only the middle row
          scrolls, so the channel stays named and its buttons stay reachable
          however far down the alert list you are. `max-h` is a floor for short
          viewports, not a second opinion - without it a 600px laptop would push
          the footer off screen. */}
      <Dialog
        open={open !== null}
        onOpenChange={(next) => !next && closeChannel(true)}
      >
        <DialogContent className="h-[42rem] max-h-[85vh] max-w-2xl gap-0 p-0 grid-rows-[minmax(0,1fr)]">
          {open && (
            // A real form, so Enter in a webhook field saves instead of doing
            // nothing. THIS is where a channel is saved: a page-level Save made
            // no sense when everything you can change lives in here.
            <form
              className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]"
              onSubmit={(e) => {
                e.preventDefault();
                if (dirty && canManage) saveChannel(open);
                else closeChannel(false);
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
                    disabled={
                      !canManage || !channels[open].enabled || !ready || dirty
                    }
                    onClick={() => void testChannel(open)}
                  >
                    <Send className="size-3.5" />
                    {testing === open ? "Sending" : "Send a test"}
                  </Button>
                  {dirty && (
                    <span className="text-xs text-muted-foreground">
                      Save to test
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => closeChannel(true)}
                  >
                    {dirty ? "Cancel" : "Close"}
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={saving || !canManage || !dirty}
                  >
                    {saving ? "Saving" : "Save"}
                  </Button>
                </div>
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
