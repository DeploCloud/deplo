"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  MoreHorizontal,
  ExternalLink,
  Logs,
  RotateCw,
  RotateCcwClock,
  GitPullRequest,
  Ban,
  Trash2,
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
import { ConfirmAction } from "@/components/shared/confirm-action";
import { RollbackDialog } from "@/components/apps/rollback-deployment";
import { gqlAction } from "@/lib/graphql-client";
import type { DeploymentStatus } from "@/lib/types/deployment";

export function DeploymentActions({
  id,
  appId,
  appSlug,
  url,
  status,
  pullRequestUrl,
  canDelete = false,
  canDeploy = false,
  canRollback = false,
  canRollbackApps = false,
  commitSha = "",
  commitMessage = "",
  onRemoved,
  onRestored,
}: {
  id: string;
  appId: string;
  appSlug: string;
  url: string;
  status: DeploymentStatus;
  pullRequestUrl?: string | null;
  canDelete?: boolean;
  canDeploy?: boolean;
  canRollback?: boolean;
  canRollbackApps?: boolean;
  commitSha?: string;
  commitMessage?: string;
  onRemoved?: () => void;
  onRestored?: () => void;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [rollbackOpen, setRollbackOpen] = React.useState(false);

  const isBuilding = status === "building";
  const canCancel = isBuilding || status === "queued";
  const isTerminal = !canCancel;

  function redeploy() {
    startTransition(async () => {
      const res = await gqlAction<
        { redeploy: { id: string | null } | null },
        { id: string | null } | null
      >(
        `mutation ($appId: String!) { redeploy(appId: $appId) { id } }`,
        { appId },
        (d) => d.redeploy,
      );
      if (res.ok) {
        toast.success("Redeploy started");
        if (res.data?.id) {
          router.push(`/apps/${appSlug}/deployments/${res.data.id}`);
        } else {
          router.refresh();
        }
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
        if (res.data)
          toast.success(isBuilding ? "Build stopped" : "Deployment canceled");
        else toast.info("This deployment already finished");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  async function deleteThis() {
    onRemoved?.();
    const res = await gqlAction<{ deleteDeployments: number }, number>(
      `mutation ($ids: [ID!]!) { deleteDeployments(ids: $ids) }`,
      { ids: [id] },
      (d) => d.deleteDeployments,
    );
    if (!res.ok) onRestored?.();
    router.refresh();
    return res;
  }

  const detailHref = `/apps/${appSlug}/deployments/${id}`;
  return (
    <>
      <div className="flex items-center justify-end gap-0.5">
        <SimpleTooltip content="Open this deployment - build logs & details">
          <Button variant="ghost" size="icon-sm" asChild>
            <Link href={detailHref} aria-label="Open deployment">
              <Logs className="size-4" />
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
            <DropdownMenuItem
              onClick={redeploy}
              disabled={pending || !canDeploy}
            >
              <RotateCw className="size-4" />
              Redeploy
            </DropdownMenuItem>
            {canRollback && (
              <DropdownMenuItem
                onSelect={() => setRollbackOpen(true)}
                disabled={pending || !canRollbackApps}
              >
                <RotateCcwClock className="size-4" />
                Rollback
              </DropdownMenuItem>
            )}
            {pullRequestUrl && (
              <DropdownMenuItem asChild>
                <a href={pullRequestUrl} target="_blank" rel="noreferrer">
                  <GitPullRequest className="size-4" />
                  Open pull request
                </a>
              </DropdownMenuItem>
            )}
            {canCancel && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onClick={cancel}
                  disabled={pending || !canDeploy}
                >
                  <Ban className="size-4" />
                  {isBuilding ? "Stop build" : "Cancel deploy"}
                </DropdownMenuItem>
              </>
            )}
            {canDelete && isTerminal && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  onSelect={() => setDeleteOpen(true)}
                  disabled={pending}
                >
                  <Trash2 className="size-4" />
                  Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <RollbackDialog
        open={rollbackOpen}
        onOpenChange={setRollbackOpen}
        id={id}
        appSlug={appSlug}
        commitSha={commitSha}
        commitMessage={commitMessage}
      />
      <ConfirmAction
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="Delete this deployment?"
        description="This removes the deployment and its build logs. The running app is unaffected, but this can't be undone."
        confirmLabel="Delete deployment"
        successMessage="Deployment deleted"
        optimistic
        onConfirm={deleteThis}
      />
    </>
  );
}
