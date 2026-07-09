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
  const canCancel = status === "building" || status === "queued";

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

  // The deployment row's actions: Visit links out, Promote shows only for
  // preview deploys, and Cancel (destructive) only while the build is in flight.
  return (
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
        <DropdownMenuItem asChild disabled={!url}>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer"
          >
            <ExternalLink className="size-4" />
            Visit
          </a>
        </DropdownMenuItem>
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
              Cancel
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
