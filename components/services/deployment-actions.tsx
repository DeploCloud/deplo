"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  MoreHorizontal,
  ExternalLink,
  ScrollText,
  RotateCw,
  ArrowUpToLine,
  Ban,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { gqlAction } from "@/lib/graphql-client";
import type { DeploymentStatus, DeploymentEnvironment } from "@/lib/types";

export function DeploymentActions({
  id,
  serviceId,
  serviceSlug,
  url,
  status,
  environment,
}: {
  id: string;
  serviceId: string;
  /** Owning service slug — used to route to the new deployment's live logs. */
  serviceSlug: string;
  url: string;
  status: DeploymentStatus;
  environment: DeploymentEnvironment;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  const isPreview = environment === "preview";
  // A build in flight can be stopped; a still-queued one is simply canceled.
  const isBuilding = status === "building";
  const canCancel = isBuilding || status === "queued";

  function redeploy() {
    startTransition(async () => {
      const res = await gqlAction<
        { redeploy: { id: string | null } | null },
        { id: string | null } | null
      >(
        `mutation ($serviceId: String!) { redeploy(serviceId: $serviceId) { id } }`,
        { serviceId },
        (d) => d.redeploy,
      );
      if (res.ok) {
        toast.success("Redeploy started");
        // Follow the new production build to its live logs; fall back to a
        // refresh if no id came back.
        if (res.data?.id) {
          router.push(`/services/${serviceSlug}/deployments/${res.data.id}`);
        } else {
          router.refresh();
        }
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
      const res = await gqlAction<{ cancelDeployment: boolean }, boolean>(
        `mutation ($id: String!) { cancelDeployment(id: $id) }`,
        { id },
        (d) => d.cancelDeployment,
      );
      if (res.ok) {
        // The server returns false when the build had already finished — don't
        // claim we stopped something we didn't (the row status here can be stale).
        if (res.data)
          toast.success(isBuilding ? "Build stopped" : "Deployment canceled");
        else toast.info("This deployment already finished");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // Two one-click destinations sit out in the open — "Open deployment" (its build
  // logs & details) and "Visit" (the live app) — so neither is buried in the menu;
  // the ⋯ keeps the mutating actions (Redeploy / Promote / Stop build). Visit only
  // shows when the deployment actually has a reachable URL.
  const detailHref = `/services/${serviceSlug}/deployments/${id}`;
  return (
    <div className="flex items-center justify-end gap-0.5">
      <SimpleTooltip content="Open this deployment — build logs & details">
        <Button variant="ghost" size="icon-sm" asChild>
          <Link href={detailHref} aria-label="Open deployment">
            <ScrollText className="size-4" />
          </Link>
        </Button>
      </SimpleTooltip>

      {url && (
        <SimpleTooltip content="Open the live app in a new tab">
          <Button variant="ghost" size="icon-sm" asChild>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Visit live app"
            >
              <ExternalLink className="size-4" />
            </a>
          </Button>
        </SimpleTooltip>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Deployment actions"
            disabled={pending}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={redeploy} disabled={pending}>
            <RotateCw className="size-4" />
            Redeploy
          </DropdownMenuItem>
          {isPreview && (
            <DropdownMenuItem onClick={promote} disabled={pending}>
              <ArrowUpToLine className="size-4" />
              Promote to Production
            </DropdownMenuItem>
          )}
          {canCancel && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={cancel}
                disabled={pending}
              >
                <Ban className="size-4" />
                {isBuilding ? "Stop build" : "Cancel deploy"}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
