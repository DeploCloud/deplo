"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Layers, Play, RefreshCw, RotateCw, Square } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { MenuSubTooltip, SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";

/** The four lifecycle actions a folder or project runs over all of its apps. */
type BulkAction = "start" | "stop" | "restart" | "redeploy";

/** The menu primitives of whichever ⋯ menu renders these items (see app-card). */
type MenuKit = {
  Item: React.ElementType;
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
};

/** One line each: what the action does, and what the toast says once it has. */
const COPY: Record<
  BulkAction,
  {
    label: string;
    icon: LucideIcon;
    /** "Stops all 5 apps in Marketing." - the sentence the dialog opens with. */
    does: string;
    /** The half-sentence after it: what the user gets for pressing the button. */
    then: string;
    /** Past tense, for the toast: "Stopped 5 apps". */
    done: string;
    destructive: boolean;
    /** Redeploy is `deploy_apps`; the other three are `control_apps`. */
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
    then: "Each one rebuilds from what it deploys from.",
    done: "Redeploying",
    destructive: false,
    deploys: true,
  },
};

const plural = (n: number) => `${n} app${n === 1 ? "" : "s"}`;

/**
 * The "Actions" submenu shared by the folder and project ⋯ menus: one action for
 * every app inside, confirmed once and run server-side (one mutation, not one call
 * per app - the ids are resolved there, so a nested folder or a second environment
 * can't be missed).
 */
export function useBulkAppActions({
  scope,
  name,
  appCount,
  canControl,
  canDeploy,
}: {
  /** Exactly one of the two - whichever card is asking. */
  scope: { folderId: string } | { projectId: string };
  /** The folder's or project's name, for the confirm copy. */
  name: string;
  /** Apps inside (a folder's whole subtree). Zero ⇒ nothing to offer. */
  appCount: number;
  /** Holds `control_apps` here (start / stop / restart). */
  canControl: boolean;
  /** Holds `deploy_apps` here (redeploy). */
  canDeploy: boolean;
}): {
  /** False when there is nothing to offer - no apps, or no capability for any
   *  of the four. The card uses it to decide whether its ⋯ menu has content. */
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
    // Nothing ran: keep the dialog open and say why, in the server's own words.
    if (ok === 0) {
      return {
        ok: false as const,
        error: error ?? "None of these apps are yours to act on.",
      };
    }
    router.refresh();
    // Partial success still closes - the work is done - but never claims the
    // apps that refused.
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
