"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Bell, ChevronLeft, Plus, Send, Trash2 } from "lucide-react";

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
import { PageHeader } from "@/components/shared/page-header";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { ALL_CHANNELS } from "@/lib/types/notification";
import { cn } from "@/lib/utils";
import type {
  NotificationChannel,
  NotificationChannelInstance,
} from "@/lib/types/notification";

const FEATURED: NotificationChannel[] = ["discord", "email", "webhook"];

export function NotificationsPanel({
  initial,
  vapidPublicKey,
  canManage,
}: {
  initial: NotificationChannelInstance[];
  vapidPublicKey: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [secrets, setSecrets] = React.useState<Secrets>({});
  const [snapshot, setSnapshot] = React.useState<string>("");
  const [saving, startSave] = React.useTransition();
  const [testing, setTesting] = React.useState(false);
  const [deleting, setDeleting] =
    React.useState<NotificationChannelInstance | null>(null);
  const { visible, remove, restore } = useOptimisticRemove(
    initial,
    (c) => c.id,
  );
  const [pendingEnabled, setPendingEnabled] = React.useState<
    Record<string, boolean>
  >({});
  const stale = Object.keys(pendingEnabled).filter((id) => {
    const served = initial.find((c) => c.id === id);
    return !served || served.enabled === pendingEnabled[id];
  });
  if (stale.length > 0)
    setPendingEnabled((p) =>
      Object.fromEntries(
        Object.entries(p).filter(([id]) => !stale.includes(id)),
      ),
    );
  const channels = visible.map((c) =>
    c.id in pendingEnabled ? { ...c, enabled: pendingEnabled[c.id] } : c,
  );

  const onCount = channels.filter((c) => c.enabled).length;
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

  function pickKind(kind: NotificationChannel) {
    setDraft({
      kind,
      name: "",
      enabled: kind !== "push",
      url: kind === "ntfy" ? "https://ntfy.sh" : "",
      target: "",
      emailFrom: "",
      emailProvider: "resend",
      smtpHost: "",
      smtpPort: 587,
      smtpUser: "",
      secretSet: false,
      secret2Set: false,
      alerts: [...DEFAULT_ALERTS],
    });
  }

  function patchDraft(value: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...value } : d));
  }

  function save() {
    if (!draft) return;
    setOpen(false);
    startSave(async () => {
      const res = await gqlAction(
        `mutation($id: ID, $input: JSON!) { saveNotificationChannel(id: $id, input: $input) }`,
        { id: editingId, input: { ...draft, secrets } },
      );
      if (res.ok) toast.success(editingId ? "Channel saved" : "Channel added");
      else {
        setOpen(true);
        toast.error(res.error);
      }
      router.refresh();
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

  async function toggle(on: boolean) {
    if (!draft) return;
    if (draft.kind === "push" && on && !(await registerPush(vapidPublicKey)))
      return;
    patchDraft({ enabled: on });
  }

  async function setEnabled(
    instance: NotificationChannelInstance,
    on: boolean,
  ) {
    if (instance.kind === "push" && on && !(await registerPush(vapidPublicKey)))
      return;
    setPendingEnabled((p) => ({ ...p, [instance.id]: on }));
    const res = await gqlAction(
      `mutation($id: ID, $input: JSON!) { saveNotificationChannel(id: $id, input: $input) }`,
      { id: instance.id, input: { ...instance, enabled: on, secrets: {} } },
    );
    if (!res.ok) {
      setPendingEnabled((p) => {
        const next = { ...p };
        delete next[instance.id];
        return next;
      });
      toast.error(res.error);
      return;
    }
    router.refresh();
  }

  const brand = draft ? CHANNEL_BRAND[draft.kind] : null;
  const ready = draft ? isChannelReady(draft, secrets) : false;

  return (
    <div className="space-y-6">
      <PageHeader
        docs="notifications.overview"
        title="Notifications"
        description="Pick a channel, then pick what it should tell you about."
        actions={
          canManage && (
            <Button size="sm" onClick={openAdd}>
              <Plus className="size-4" />
              Add channel
            </Button>
          )
        }
      />

      <div
        className={cn(
          "grid items-start gap-6",
          channels.length > 0 && "xl:grid-cols-[minmax(0,1fr)_260px]",
        )}
      >
        <div className="min-w-0 space-y-4">
          {channels.length === 0 ? (
            <EmptyState
              graphic={<NotificationIllustration caption={false} />}
              className="py-12"
              title="No channels yet"
              docs="notifications.channels"
              description="Add a channel, then pick what it should tell you about."
            />
          ) : (
            <div className="space-y-3">
              <div className="flex w-fit flex-wrap items-center gap-1.5 px-1 text-sm font-medium">
                <Bell className="size-4" />
                Alert channels
                <InfoTip
                  content="Where alerts go. Each channel carries its own list of what it is told about."
                  docs="notifications.channels"
                />
                <Badge
                  variant={onCount === 0 ? "muted" : "secondary"}
                  className="tabular-nums"
                >
                  {onCount} on
                </Badge>
              </div>
              <div className="grid items-start gap-3 sm:grid-cols-2">
                {channels.map((instance) => (
                  <ChannelRow
                    key={instance.id}
                    instance={instance}
                    canManage={canManage}
                    onOpen={() => openChannel(instance)}
                    onDelete={() => setDeleting(instance)}
                    onToggle={(on) => void setEnabled(instance, on)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {channels.length > 0 && (
          <aside className="hidden xl:sticky xl:top-20 xl:block">
            <NotificationIllustration />
          </aside>
        )}
      </div>

      <Dialog open={open} onOpenChange={(next) => !next && setOpen(false)}>
        <DialogContent
          selfManaged
          className="h-[46rem] max-h-[85vh] max-w-2xl grid-rows-[minmax(0,1fr)] gap-0 p-0"
        >
          <form
            className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              if (draft && canManage && (dirty || !editingId)) save();
              else setOpen(false);
            }}
          >
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
                      <KindTile
                        key={kind}
                        kind={kind}
                        featured
                        onPick={pickKind}
                      />
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

            <DialogFooter className="items-center gap-1.5 border-t border-border p-4">
              <div className="flex flex-wrap items-center gap-1.5">
                {draft && !editingId && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setDraft(null);
                      setSecrets({});
                    }}
                  >
                    <ChevronLeft className="size-3.5" />
                    Back
                  </Button>
                )}
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
        title="Remove channel?"
        description={`${deleting ? deleting.name || CHANNEL_BRAND[deleting.kind].label : "This channel"} stops receiving alerts, and what it was subscribed to is forgotten.`}
        confirmLabel="Remove"
        successMessage="Channel removed"
        optimistic
        onConfirm={async () => {
          const id = deleting!.id;
          remove(id);
          const res = await gqlAction(
            `mutation($id: ID!) { deleteNotificationChannel(id: $id) }`,
            { id },
          );
          if (!res.ok) restore(id);
          router.refresh();
          return res;
        }}
      />
    </div>
  );
}

async function registerPush(vapidPublicKey: string): Promise<boolean> {
  if (
    typeof window === "undefined" ||
    !("serviceWorker" in navigator) ||
    !("PushManager" in window) ||
    !window.isSecureContext
  ) {
    toast.error("Browser push needs this panel to be served over https");
    return false;
  }
  if ((await Notification.requestPermission()) !== "granted") {
    toast.error("Your browser blocked notifications for this site");
    return false;
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
      return false;
    }
    return true;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : String(e));
    return false;
  }
}

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

function ChannelRow({
  instance,
  canManage,
  onOpen,
  onDelete,
  onToggle,
}: {
  instance: NotificationChannelInstance;
  canManage: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onToggle: (on: boolean) => void;
}) {
  const brand = CHANNEL_BRAND[instance.kind];
  const ready = isChannelReady(instance, {});
  const target = channelTarget(instance);
  const noAlerts = instance.alerts.length === 0;
  const status = !instance.enabled
    ? ""
    : !ready
      ? "Needs setup"
      : noAlerts
        ? "No alerts picked"
        : "";
  return (
    <Card className="flex items-center gap-3 p-3 transition-colors hover:border-ring hover:bg-accent">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChannelMark channel={instance.kind} />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">
              {instance.name || brand.label}
            </span>
            {instance.name && <Badge variant="secondary">{brand.label}</Badge>}
            {brand.beta && (
              <Badge variant="info" className="px-1.5 py-0 text-[10px]">
                Beta
              </Badge>
            )}
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {target && <span className="truncate font-mono">{target}</span>}
            {target && status && <span aria-hidden>·</span>}
            {status && (
              <span
                className={
                  instance.enabled && (!ready || noAlerts)
                    ? "text-[var(--warning)]"
                    : undefined
                }
              >
                {status}
              </span>
            )}
          </span>
        </span>
      </button>
      <Switch
        checked={instance.enabled}
        disabled={!canManage}
        aria-label={`Turn ${instance.name || brand.label} ${instance.enabled ? "off" : "on"}`}
        onCheckedChange={onToggle}
      />
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
    </Card>
  );
}
