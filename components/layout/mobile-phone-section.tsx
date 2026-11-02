"use client";

import * as React from "react";
import { toast } from "sonner";
import { Bell, Download, Share, SquarePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { registerPush } from "@/components/settings/register-push";
import { DEFAULT_ALERTS } from "@/lib/alerts";
import { gqlAction } from "@/lib/graphql-client";
import {
  isInstalled,
  isIos,
  promptInstall,
  pushSupported,
  useInstallState,
} from "./pwa";
import type { TeamIdentity } from "@/lib/types/team";

type Channel = "ON" | "OFF" | "NONE";

// "This phone" in the More panel: install Deplo, and get the active team's alerts here.
export function PhoneRows({
  team,
  canManageAlerts,
  Row,
}: {
  team: TeamIdentity;
  canManageAlerts: boolean;
  Row: (p: {
    icon: React.ComponentType<{ className?: string }>;
    title: string;
    sub?: string;
    trail?: React.ReactNode;
    onClick?: () => void;
  }) => React.ReactNode;
}) {
  const install = useInstallState();
  const [iosOpen, setIosOpen] = React.useState(false);
  return (
    <>
      {(install === "prompt" || install === "ios") && (
        <Row
          icon={Download}
          title="Install Deplo"
          sub="Open it from your home screen, like an app"
          onClick={() =>
            install === "prompt" ? void promptInstall() : setIosOpen(true)
          }
        />
      )}
      <PushRow team={team} canManageAlerts={canManageAlerts} Row={Row} />
      <IosInstallDialog open={iosOpen} onOpenChange={setIosOpen} />
    </>
  );
}

function PushRow({
  team,
  canManageAlerts,
  Row,
}: {
  team: TeamIdentity;
  canManageAlerts: boolean;
  Row: Parameters<typeof PhoneRows>[0]["Row"];
}) {
  const storeKey = `deplo.push.${team.id}`;
  const [info, setInfo] = React.useState<{ channel: Channel; key: string }>();
  const [on, setOn] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const supported = typeof window !== "undefined" && pushSupported();

  React.useEffect(() => {
    let alive = true;
    void gqlAction<{ teamPushChannel: Channel; webPushPublicKey: string }>(
      `{ teamPushChannel webPushPublicKey }`,
    ).then((res) => {
      if (alive && res.ok && res.data)
        setInfo({
          channel: res.data.teamPushChannel,
          key: res.data.webPushPublicKey,
        });
    });
    if (pushSupported())
      void navigator.serviceWorker
        .getRegistration()
        .then((reg) => reg?.pushManager.getSubscription())
        .then((sub) => {
          if (!alive) return;
          setOn(
            Boolean(sub) &&
              Notification.permission === "granted" &&
              localStorage.getItem(storeKey) === sub?.endpoint,
          );
        });
    return () => {
      alive = false;
    };
  }, [storeKey]);

  async function toggle(next: boolean) {
    if (!info) return;
    setBusy(true);
    try {
      if (next) {
        const endpoint = await registerPush(info.key);
        if (!endpoint) return;
        if (info.channel === "NONE") {
          const res = await gqlAction(
            `mutation($input: JSON!) { saveNotificationChannel(input: $input) }`,
            {
              input: {
                kind: "push",
                enabled: true,
                alerts: [...DEFAULT_ALERTS],
              },
            },
          );
          if (!res.ok) return void toast.error(res.error);
          setInfo({ ...info, channel: "ON" });
        }
        localStorage.setItem(storeKey, endpoint);
        setOn(true);
        toast.success(`Alerts for ${team.name} will reach this phone`);
      } else {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (sub) {
          const res = await gqlAction(
            `mutation($endpoint: String!) { unsubscribeWebPush(endpoint: $endpoint) }`,
            { endpoint: sub.endpoint },
          );
          if (!res.ok) return void toast.error(res.error);
        }
        localStorage.removeItem(storeKey);
        setOn(false);
      }
    } finally {
      setBusy(false);
    }
  }

  let sub = `For ${team.name}`;
  let usable = Boolean(info) && supported;
  if (!supported) {
    sub =
      typeof window !== "undefined" && isIos() && !isInstalled()
        ? "Install Deplo first to get alerts here"
        : "This browser cannot show alerts";
  } else if (info && info.channel !== "ON" && !on) {
    if (!canManageAlerts) {
      sub = "Ask an admin to turn on phone alerts";
      usable = false;
    } else if (info.channel === "OFF") {
      sub = "Turned off in Notifications settings";
      usable = false;
    }
  }

  return (
    <Row
      icon={Bell}
      title="Notifications on this phone"
      sub={sub}
      trail={
        <Switch
          checked={on}
          disabled={!usable || busy}
          onCheckedChange={(v) => void toggle(v)}
          aria-label="Notifications on this phone"
        />
      }
    />
  );
}

function IosInstallDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install Deplo</DialogTitle>
          <DialogDescription>
            It opens full screen, and{" "}
            <strong>alerts can reach this phone</strong>.
          </DialogDescription>
        </DialogHeader>
        <ol className="flex flex-col gap-3 text-[15px]">
          <Step n={1}>
            Tap <Share className="inline size-[18px] align-[-3px]" /> Share in
            Safari&apos;s toolbar
          </Step>
          <Step n={2}>
            Tap <SquarePlus className="inline size-[18px] align-[-3px]" /> Add
            to Home Screen
          </Step>
          <Step n={3}>Tap Add, then open Deplo from your home screen</Step>
        </ol>
        <DialogFooter>
          <DialogClose asChild>
            <Button>Done</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent text-sm font-medium">
        {n}
      </span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}
