"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bell, Plus, Send, Trash2 } from "lucide-react";

import { AlertPicker } from "@/components/settings/alert-picker";
import {
  CHANNEL_BRAND,
  ChannelMark,
} from "@/components/settings/channel-brand";
import {
  ChannelConfig,
  channelTarget,
  isChannelReady,
  type Draft,
  type Secrets,
} from "@/components/settings/channel-config";
import { NotificationIllustration } from "@/components/settings/notification-illustration";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { InfoTip } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { gqlAction } from "@/lib/graphql-client";
import { DEFAULT_ALERTS } from "@/lib/alerts";
import { ALL_ALERTS, ALL_CHANNELS } from "@/lib/types";
import type {
  NotificationChannel,
  NotificationChannelInstance,
} from "@/lib/types";

/**
 * The three the picker leads with. They are the three that are not beta, which
 * is the same thing as the three we are confident about — but SPELLED OUT
 * rather than derived from `beta`, so a channel leaving beta does not silently
 * become a fourth tile in a three-column grid.
 */
const FEATURED: NotificationChannel[] = ["discord", "email", "webhook"];

/**
 * The notification settings.
 *
 * The page is a LIST OF CONFIGURED CHANNELS and nothing else — not the twelve
 * types, the ones this team actually set up, and a type may appear as many
 * times as it likes. Two Discord rooms with different alert lists is the normal
 * case, so a row is one destination rather than one kind.
 *
 * Everything editable lives in one modal, which serves both add and edit: a
 * type picker when there is nothing yet, then the name, that kind's fields, and
 * its own alert list. Opening snapshots the draft and dismissing throws it away,
 * so Save means exactly what it says.
 */
export function NotificationsPanel({
  initial,
  vapidPublicKey,
  canManage,
}: {
  initial: NotificationChannelInstance[];
  vapidPublicKey: string;
  /** Cosmetic: the real gate is `manage_notifications` in the data layer. */
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  /** The channel being edited, or null while creating a new one. */
  const [editingId, setEditingId] = React.useState<string | null>(null);
  /** The working copy. Null while creating and no type has been picked yet. */
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [secrets, setSecrets] = React.useState<Secrets>({});
  /** What the draft looked like when the modal opened, so Cancel is a cancel. */
  const [snapshot, setSnapshot] = React.useState<string>("");
  const [saving, startSave] = React.useTransition();
  const [testing, setTesting] = React.useState(false);
  const [deleting, setDeleting] =
    React.useState<NotificationChannelInstance | null>(null);

  const onCount = initial.filter((c) => c.enabled).length;
  const dirty = JSON.stringify({ draft, secrets }) !== snapshot;

  function openChannel(instance: NotificationChannelInstance) {
    const { id, ...rest } = instance;
    setEditingId(id);
    setDraft(rest);
    setSecrets({});
    setSnapshot(JSON.stringify({ draft: rest, secrets: {} }));
    setOpen(true);
  }

  function openAdd() {
    setEditingId(null);
    setDraft(null);
    setSecrets({});
    setSnapshot(JSON.stringify({ draft: null, secrets: {} }));
    setOpen(true);
  }

  /** A channel of this kind that nobody has configured yet. */
  function pickKind(kind: NotificationChannel) {
    setDraft({
      kind,
      name: "",
      enabled: true,
      // ntfy is the one kind with a meaningful default address.
      url: kind === "ntfy" ? "https://ntfy.sh" : "",
      target: "",
      emailFrom: "",
      emailProvider: "resend",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      secretSet: false,
      secret2Set: false,
      // Nothing is written for these until Save: a channel with no stored rows
      // already resolves to exactly this.
      alerts: [...DEFAULT_ALERTS],
    });
  }

  function patchDraft(value: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...value } : d));
  }

  function save() {
    if (!draft) return;
    startSave(async () => {
      const res = await gqlAction(
        `mutation($id: ID, $input: JSON!) { saveNotificationChannel(id: $id, input: $input) }`,
        { id: editingId, input: { ...draft, secrets } },
      );
      if (res.ok) {
        toast.success(editingId ? "Channel saved" : "Channel added");
        setOpen(false);
        router.refresh();
      } else toast.error(res.error);
    });
  }

  async function test() {
    if (!editingId) return;
    setTesting(true);
    try {
      const res = await gqlAction(
        `mutation($id: ID!) { testNotificationChannel(id: $id) }`,
        { id: editingId },
      );
      if (res.ok) toast.success("Test alert sent");
      else toast.error(res.error);
    } finally {
      setTesting(false);
    }
  }

  /**
   * Turning a channel on. Only browser push does anything beyond flipping the
   * flag: it has to ask this device for permission and register a worker, and
   * that has to succeed before the switch is allowed to look on.
   */
  async function toggle(on: boolean) {
    if (!draft) return;
    if (draft.kind !== "push" || !on) {
      patchDraft({ enabled: on });
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
      patchDraft({ enabled: true });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  const brand = draft ? CHANNEL_BRAND[draft.kind] : null;
  const ready = draft ? isChannelReady(draft, secrets) : false;

  return (
    <>
      <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_260px]">
        <div className="min-w-0 space-y-4">
          <Card>
            <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
              <CardTitle className="flex w-fit flex-wrap items-center gap-1.5">
                <Bell className="size-4" />
                Alert channels
                <InfoTip content="Where alerts go. Each channel carries its own list of what it is told about." />
                <Badge
                  variant={onCount === 0 ? "muted" : "secondary"}
                  className="tabular-nums"
                >
                  {onCount} on
                </Badge>
              </CardTitle>
              {canManage && (
                <Button size="sm" onClick={openAdd}>
                  <Plus className="size-4" />
                  Add channel
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {initial.length === 0 ? (
                <EmptyState
                  icon={Bell}
                  title="No channels yet"
                  description="Add a channel, then pick what it should tell you about."
                />
              ) : (
                <div className="space-y-2">
                  {initial.map((instance) => (
                    <ChannelRow
                      key={instance.id}
                      instance={instance}
                      canManage={canManage}
                      onOpen={() => openChannel(instance)}
                      onDelete={() => setDeleting(instance)}
                    />
                  ))}
                </div>
              )}
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
          Its height is FIXED, not content-driven: the twelve kinds range from no
          fields at all to six, and a modal that resized to each of them would
          jump every time you opened a different one. Only the middle row
          scrolls, so the channel stays named and its buttons stay reachable
          however far down the alert list you are. `max-h` is a floor for short
          viewports - without it a 600px laptop would push the footer off screen. */}
      <Dialog open={open} onOpenChange={(next) => !next && setOpen(false)}>
        <DialogContent className="h-[46rem] max-h-[85vh] max-w-2xl gap-0 p-0 grid-rows-[minmax(0,1fr)]">
          {/* A real form, so Enter in a webhook field saves instead of doing
              nothing. THIS is where a channel is saved: a page-level Save made
              no sense when everything you can change lives in here. */}
          <form
            className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft && canManage && (dirty || !editingId)) save();
              else setOpen(false);
            }}
          >
            {/* pr-12 keeps the switch clear of the modal's own close button. */}
            <div className="flex items-start gap-3 border-b border-border p-4 pr-12">
              {draft && brand ? (
                <>
                  <ChannelMark channel={draft.kind} />
                  <div className="min-w-0 flex-1">
                    <DialogTitle className="flex items-center gap-1.5">
                      {draft.name || brand.label}
                      {brand.beta && (
                        <Badge
                          variant="info"
                          className="px-1.5 py-0 text-[10px]"
                        >
                          Beta
                        </Badge>
                      )}
                    </DialogTitle>
                    <DialogDescription className="mt-1">
                      {brand.description}
                    </DialogDescription>
                  </div>
                  <Switch
                    checked={draft.enabled}
                    disabled={!canManage}
                    aria-label={`Turn ${brand.label} on`}
                    onCheckedChange={(on) => void toggle(on)}
                  />
                </>
              ) : (
                <div className="min-w-0 flex-1">
                  <DialogTitle>Add a channel</DialogTitle>
                  <DialogDescription className="mt-1">
                    Pick where these alerts should go. You can add the same one
                    more than once.
                  </DialogDescription>
                </div>
              )}
            </div>

            <div className="min-h-0 space-y-5 overflow-y-auto p-4">
              {!draft ? (
                <div className="space-y-4">
                  <div className="grid gap-2 sm:grid-cols-3">
                    {FEATURED.map((kind) => (
                      <KindTile key={kind} kind={kind} featured onPick={pickKind} />
                    ))}
                  </div>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">
                      More channels
                    </p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {ALL_CHANNELS.filter((k) => !FEATURED.includes(k)).map(
                        (kind) => (
                          <KindTile key={kind} kind={kind} onPick={pickKind} />
                        ),
                      )}
                    </div>
                  </div>
                </div>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label
                      htmlFor="channel-name"
                      className="text-xs text-muted-foreground"
                    >
                      Name
                    </Label>
                    <Input
                      id="channel-name"
                      value={draft.name}
                      disabled={!canManage}
                      onChange={(e) => patchDraft({ name: e.target.value })}
                      // Optional on purpose: it earns its place when a team has
                      // two of a kind, and asks for nothing when it does not.
                      placeholder={brand?.label}
                    />
                  </div>
                  <ChannelConfig
                    draft={draft}
                    secrets={secrets}
                    onPatch={patchDraft}
                    onSecret={(key, value) =>
                      setSecrets((s) => ({ ...s, [key]: value }))
                    }
                    readOnly={!canManage}
                  />
                  <AlertPicker
                    alerts={draft.alerts}
                    disabled={!canManage}
                    onChange={(alerts) => patchDraft({ alerts })}
                  />
                </>
              )}
            </div>

            <DialogFooter className="items-center gap-1.5 border-t border-border p-4 sm:justify-between">
              <div className="flex flex-wrap items-center gap-1.5">
                {/* A test dials whatever the SERVER has stored, so it is only
                    offered once there IS something stored and nothing is
                    pending on top of it. */}
                {editingId && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={
                        !canManage ||
                        !draft?.enabled ||
                        !ready ||
                        dirty ||
                        testing
                      }
                      onClick={() => void test()}
                    >
                      <Send className="size-3.5" />
                      {testing ? "Sending" : "Send a test"}
                    </Button>
                    {dirty && (
                      <span className="text-xs text-muted-foreground">
                        Save to test
                      </span>
                    )}
                  </>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setOpen(false)}
                >
                  {dirty ? "Cancel" : "Close"}
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    saving || !canManage || !draft || (!!editingId && !dirty)
                  }
                >
                  {saving ? "Saving" : editingId ? "Save" : "Add channel"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmAction
        open={deleting !== null}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={`Remove ${deleting ? deleting.name || CHANNEL_BRAND[deleting.kind].label : "this channel"}?`}
        description="It stops receiving alerts, and what it was subscribed to is forgotten."
        confirmLabel="Remove"
        successMessage="Channel removed"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: ID!) { deleteNotificationChannel(id: $id) }`,
            { id: deleting!.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </>
  );
}

/**
 * One choice in the Add picker. The featured three stand up (mark above the
 * name, centred, taller) so the eye lands on them first; the rest keep the
 * compact row shape, which is what makes "the rest" read as a list.
 */
function KindTile({
  kind,
  featured,
  onPick,
}: {
  kind: NotificationChannel;
  featured?: boolean;
  onPick: (kind: NotificationChannel) => void;
}) {
  const brand = CHANNEL_BRAND[kind];
  const base =
    "rounded-lg border p-3 text-left transition-colors hover:border-ring hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  if (featured)
    return (
      <button
        type="button"
        onClick={() => onPick(kind)}
        className={`flex flex-col items-center gap-2 border-border ${base} py-4 text-center`}
      >
        <ChannelMark channel={kind} className="size-10" />
        <span className="text-sm font-medium">{brand.label}</span>
        <span className="text-xs leading-snug text-muted-foreground">
          {brand.description}
        </span>
      </button>
    );
  return (
    <button
      type="button"
      onClick={() => onPick(kind)}
      className={`flex items-center gap-3 border-border ${base}`}
    >
      <ChannelMark channel={kind} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{brand.label}</span>
          {brand.beta && (
            <Badge variant="info" className="px-1.5 py-0 text-[10px]">
              Beta
            </Badge>
          )}
        </span>
        <span className="mt-1 block text-xs text-muted-foreground">
          {brand.description}
        </span>
      </span>
    </button>
  );
}

/**
 * One configured channel: what it is called, where it sends, whether it is on
 * and how much it is told. The left side is the button; the trash sits outside
 * it, the shape a registry row already uses.
 */
function ChannelRow({
  instance,
  canManage,
  onOpen,
  onDelete,
}: {
  instance: NotificationChannelInstance;
  canManage: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const brand = CHANNEL_BRAND[instance.kind];
  // A stored channel's secrets are already set, so the row asks for nothing extra.
  const ready = isChannelReady(instance, {});
  const target = channelTarget(instance);
  const status = !instance.enabled
    ? "Off"
    : !ready
      ? "Needs setup"
      : `${instance.alerts.length} of ${ALL_ALERTS.length} alerts`;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-ring hover:bg-accent">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChannelMark channel={instance.kind} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {instance.name || brand.label}
            </span>
            {/* The type, only once a name has taken its place. On an unnamed row
                the title already says Discord and a badge would say it twice. */}
            {instance.name && <Badge variant="secondary">{brand.label}</Badge>}
            {brand.beta && (
              <Badge variant="info" className="px-1.5 py-0 text-[10px]">
                Beta
              </Badge>
            )}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {target && (
              <>
                <span className="truncate font-mono">{target}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span
              className={
                instance.enabled && !ready ? "text-[var(--warning)]" : undefined
              }
            >
              {status}
            </span>
          </span>
        </span>
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{
            backgroundColor: instance.enabled && ready ? brand.bg : "transparent",
            boxShadow:
              instance.enabled && ready
                ? undefined
                : "inset 0 0 0 1.5px var(--border)",
          }}
        />
      </button>
      {canManage && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label={`Remove ${instance.name || brand.label}`}
        >
          <Trash2 className="size-4" />
        </Button>
      )}
    </div>
  );
}
