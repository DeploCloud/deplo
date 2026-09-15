"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Layers, Play, RefreshCw, RotateCw, Square } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { MenuSubTooltip, SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";

type BulkAction = "start" | "stop" | "restart" | "redeploy";

type MenuKit = {
  Item: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
};

const COPY: Record<
  BulkAction,
  {
    label: string;
    icon: LucideIcon;
    does: string;
    then: string;
    done: string;
    destructive: boolean;
    deploys?: boolean;
  }
> = {
  start: {
    label: "Start",
    icon: Play,
    does: "Starts",
    then: "Ones already running stay as they are.",
    done: "Started",
    destructive: false,
  },
  stop: {
    label: "Stop",
    icon: Square,
    does: "Stops",
    then: "Their sites go offline until you start them again.",
    done: "Stopped",
    destructive: true,
  },
  restart: {
    label: "Restart",
    icon: RefreshCw,
    does: "Stops and starts",
    then: "Their sites are offline for a moment.",
    done: "Restarted",
    destructive: true,
  },
  redeploy: {
    label: "Redeploy",
    icon: RotateCw,
    does: "Redeploys",
    then: "Each one deploys again from its own source.",
    done: "Redeploying",
    destructive: false,
    deploys: true,
  },
};

const plural = (n: number) => `${n} app${n === 1 ? "" : "s"}`;

export function useBulkAppActions({
  scope,
  name,
  appCount,
  canControl,
  canDeploy,
}: {
  scope: { folderId: string } | { projectId: string };
  name: string;
  appCount: number;
  canControl: boolean;
  canDeploy: boolean;
}): {
  available: boolean;
  items: (K: MenuKit) => React.ReactNode;
  dialog: React.ReactNode;
} {
  const router = useRouter();
  const [confirming, setConfirming] = React.useState<BulkAction | null>(null);

  const offered = (Object.keys(COPY) as BulkAction[]).filter((a) =>
    COPY[a].deploys ? canDeploy : canControl,
  );
  if (appCount === 0 || offered.length === 0) {
    return { available: false, items: () => null, dialog: null };
  }

  async function run(action: BulkAction) {
    const vars =
      "folderId" in scope
        ? { folderId: scope.folderId }
        : { projectId: scope.projectId };
    const res = await gqlAction<
      Record<string, { ok: number; failed: number; error: string | null }>,
      { ok: number; failed: number; error: string | null }
    >(
      action === "redeploy"
        ? `mutation($folderId: ID, $projectId: ID) {
             bulkRedeployApps(folderId: $folderId, projectId: $projectId) { ok failed error }
           }`
        : `mutation($action: BulkAppAction!, $folderId: ID, $projectId: ID) {
             bulkAppAction(action: $action, folderId: $folderId, projectId: $projectId) { ok failed error }
           }`,
      action === "redeploy" ? vars : { action, ...vars },
      (d) => d.bulkRedeployApps ?? d.bulkAppAction,
    );
    if (!res.ok) return res;
    const { ok, failed, error } = res.data!;
    if (ok === 0) {
      return {
        ok: false as const,
        error: error ?? "None of these apps are yours to act on.",
      };
    }
    router.refresh();
    if (failed > 0) {
      toast.error(
        `${COPY[action].done} ${ok} of ${plural(ok + failed)} - ${error}`,
      );
      return { ok: true as const };
    }
    toast.success(`${COPY[action].done} ${plural(ok)}`);
    return { ok: true as const };
  }

  const items = (K: MenuKit) => (
    <MenuSubTooltip
      Sub={K.Sub}
      SubTrigger={K.SubTrigger}
      SubContent={K.SubContent}
      content={`Run one action on all ${plural(appCount)} inside`}
      trigger={
        <>
          <Layers className="size-4" />
          Actions
        </>
      }
    >
      {offered.map((action) => {
        const { label, icon: Icon, does, then } = COPY[action];
        return (
          <SimpleTooltip
            key={action}
            content={`${does} all ${plural(appCount)} in ${name}. ${then}`}
            side="left"
          >
            <K.Item onSelect={() => setConfirming(action)}>
              <Icon className="size-4" />
              {label}
            </K.Item>
          </SimpleTooltip>
        );
      })}
    </MenuSubTooltip>
  );

  const action = confirming;
  const dialog = action ? (
    <ConfirmAction
      open
      onOpenChange={(o) => {
        if (!o) setConfirming(null);
      }}
      title={`${COPY[action].label} all apps?`}
      description={`${COPY[action].does} all ${plural(appCount)} in ${name}. ${COPY[action].then}`}
      confirmLabel={`${COPY[action].label} apps`}
      variant={COPY[action].destructive ? "destructive" : "default"}
      onConfirm={() => run(action)}
    />
  ) : null;

  return { available: true, items, dialog };
}
