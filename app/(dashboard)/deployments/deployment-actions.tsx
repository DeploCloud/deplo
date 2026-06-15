"use client";

import * as React from "react";
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
  redeployAction,
  cancelDeploymentAction,
  promoteAction,
} from "@/lib/actions/projects";
import type { DeploymentStatus, DeploymentEnvironment } from "@/lib/types";

export function DeploymentActions({
  id,
  projectId,
  url,
  status,
  environment,
}: {
  id: string;
  projectId: string;
  url: string;
  status: DeploymentStatus;
  environment: DeploymentEnvironment;
}) {
  const [pending, startTransition] = React.useTransition();

  const isPreview = environment === "preview";
  const canCancel = status === "building" || status === "queued";

  function redeploy() {
    startTransition(async () => {
      const res = await redeployAction(projectId);
      if (res.ok) toast.success("Redeploy started");
      else toast.error(res.error);
    });
  }

  function promote() {
    startTransition(async () => {
      const res = await promoteAction(id);
      if (res.ok) toast.success("Promoted to production");
      else toast.error(res.error);
    });
  }

  function cancel() {
    startTransition(async () => {
      const res = await cancelDeploymentAction(id);
      if (res.ok) toast.success("Deployment canceled");
      else toast.error(res.error);
    });
  }

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
