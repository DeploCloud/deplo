"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MoreHorizontal,
  ExternalLink,
  RotateCw,
  ArrowUpToLine,
  Ban,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { gqlAction } from "@/lib/graphql-client";
import type { DeploymentStatus, DeploymentEnvironment } from "@/lib/types";

/**
 * The menu-primitive set used to render the row's action list once and reuse it
 * for BOTH the ⋯ dropdown (left-click) and the right-click context menu — same
 * items, same handlers, no duplication. Radix dropdown and context menus share
 * an isomorphic API, so the renderer just takes whichever component set applies
 * (see the note in service-card.tsx).
 */
type MenuKit = {
  Item: React.ElementType;
  Separator: React.ElementType;
};

const DROPDOWN_KIT: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
};
const CONTEXT_KIT: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
};

export function DeploymentActions({
  id,
  serviceId,
  url,
  status,
  environment,
}: {
  id: string;
  serviceId: string;
  url: string;
  status: DeploymentStatus;
  environment: DeploymentEnvironment;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const isPreview = environment === "preview";
  const canCancel = status === "building" || status === "queued";

  function redeploy() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($serviceId: String!) { redeploy(serviceId: $serviceId) { id } }`,
        { serviceId },
      );
      if (res.ok) {
        toast.success("Redeploy started");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function promote() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($id: String!) { promoteDeployment(id: $id) }`,
        { id },
      );
      if (res.ok) {
        toast.success("Promoted to production");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  function cancel() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($id: String!) { cancelDeployment(id: $id) }`,
        { id },
      );
      if (res.ok) {
        toast.success("Deployment canceled");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // The deployment row's actions, rendered once for whichever menu primitive is
  // passed. Visit links out, Promote shows only for preview deploys, and Cancel
  // (destructive) only while the build is in flight — same gating in both menus.
  const menu = (K: MenuKit) => (
    <>
      <K.Item asChild disabled={!url}>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="cursor-pointer"
        >
          <ExternalLink className="size-4" />
          Visit
        </a>
      </K.Item>
      <K.Item onClick={redeploy} disabled={pending}>
        <RotateCw className="size-4" />
        Redeploy
      </K.Item>
      {isPreview && (
        <K.Item onClick={promote} disabled={pending}>
          <ArrowUpToLine className="size-4" />
          Promote to Production
        </K.Item>
      )}
      {canCancel && (
        <>
          <K.Separator />
          <K.Item variant="destructive" onClick={cancel} disabled={pending}>
            <Ban className="size-4" />
            Cancel
          </K.Item>
        </>
      )}
    </>
  );

  // Right-clicking the row's action surface opens the same menu as ⋯; stop
  // propagation so the app-wide shell context menu doesn't also fire.
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Deployment actions"
              disabled={pending}
              onContextMenu={(e) => e.stopPropagation()}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {menu(DROPDOWN_KIT)}
          </DropdownMenuContent>
        </DropdownMenu>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        {menu(CONTEXT_KIT)}
      </ContextMenuContent>
    </ContextMenu>
  );
}
