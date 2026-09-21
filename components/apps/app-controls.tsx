"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  MoreHorizontal,
  Play,
  Square,
  RefreshCw,
  Loader2,
  ExternalLink,
  GitBranch,
  Settings,
  ArrowLeftRight,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { DeleteWithArtifacts } from "@/components/shared/delete-with-artifacts";
import { TransferTeamDialog } from "@/components/apps/settings/transfer-team-dialog";
import { gqlAction } from "@/lib/graphql-client";
import {
  useLiveStatus,
  useNeverDeployed,
} from "@/components/apps/app-live-status";
import { needsCapability, useAppCan } from "@/components/apps/app-capabilities";
import type { AppStatus } from "@/lib/types/app";
import type { Capability } from "@/lib/types/identity";

export function AppControls({
  appId,
  slug,
  name,
  status: serverStatus,
  productionUrl,
  repoUrl,
}: {
  appId: string;
  slug: string;
  name: string;
  status: AppStatus;
  productionUrl: string | null;
  repoUrl: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [transferOpen, setTransferOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const status = useLiveStatus(serverStatus);
  const neverDeployed = useNeverDeployed();
  const canControl = useAppCan("control_apps");
  const canMove = useAppCan("move_apps");
  const canDelete = useAppCan("delete_apps");
  const stopped = status === "idle";
  const stopping = status === "stopping";
  const restoring = status === "restoring";

  const tip = (cap: Capability, can: boolean, text: string) =>
    can ? text : needsCapability(cap);

  function act(mutation: string, success: string) {
    startTransition(async () => {
      const res = await gqlAction(mutation, { id: appId });
      if (res.ok) {
        toast.success(success);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  function reload() {
    startTransition(async () => {
      const res = await gqlAction<{ reloadApp: string | null }, string>(
        `mutation($id: String!) { reloadApp(id: $id) }`,
        { id: appId },
        (d) => d.reloadApp ?? "",
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(
        res.data === "rerouted"
          ? "Routing reloaded"
          : res.data === "unchanged"
            ? "Already up to date"
            : "Saved - applies on the next deploy",
      );
      router.refresh();
    });
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label="App actions"
            disabled={pending}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {neverDeployed ? null : (
            <>
              {restoring ? (
                <SimpleTooltip
                  content="A backup is being restored into this app"
                  side="left"
                >
                  <DropdownMenuItem disabled>
                    <Loader2 className="size-4 animate-spin" />
                    Restoring
                  </DropdownMenuItem>
                </SimpleTooltip>
              ) : stopping ? (
                <SimpleTooltip
                  content="The container is currently stopping"
                  side="left"
                >
                  <DropdownMenuItem disabled>
                    <Loader2 className="size-4 animate-spin" />
                    Stopping
                  </DropdownMenuItem>
                </SimpleTooltip>
              ) : stopped ? (
                <SimpleTooltip
                  content={tip(
                    "control_apps",
                    canControl,
                    "Start this app's stopped container",
                  )}
                  side="left"
                >
                  <DropdownMenuItem
                    onSelect={() =>
                      act(
                        `mutation($id: String!) { startApp(id: $id) { id } }`,
                        "Container started",
                      )
                    }
                    disabled={!canControl}
                  >
                    <Play className="size-4" />
                    Start
                  </DropdownMenuItem>
                </SimpleTooltip>
              ) : (
                <SimpleTooltip
                  content={tip(
                    "control_apps",
                    canControl,
                    "Stop this app's running container",
                  )}
                  side="left"
                >
                  <DropdownMenuItem
                    onSelect={() =>
                      act(
                        `mutation($id: String!) { stopApp(id: $id) { id } }`,
                        "Container stopped",
                      )
                    }
                    disabled={!canControl}
                  >
                    <Square className="size-4" />
                    Stop
                  </DropdownMenuItem>
                </SimpleTooltip>
              )}
              <SimpleTooltip
                content={tip(
                  "control_apps",
                  canControl,
                  "Re-apply domains and basic auth to the running container, no rebuild",
                )}
                side="left"
              >
                <DropdownMenuItem
                  onSelect={reload}
                  disabled={!canControl || restoring}
                >
                  <RefreshCw className="size-4" />
                  Reload
                </DropdownMenuItem>
              </SimpleTooltip>
              <DropdownMenuSeparator />
            </>
          )}

          {productionUrl && (
            <SimpleTooltip content="Open the live app in a new tab" side="left">
              <DropdownMenuItem asChild>
                <a href={productionUrl} target="_blank" rel="noreferrer">
                  <ExternalLink className="size-4" />
                  Visit
                </a>
              </DropdownMenuItem>
            </SimpleTooltip>
          )}
          {repoUrl && (
            <SimpleTooltip
              content="Open the repository this app deploys from"
              side="left"
            >
              <DropdownMenuItem asChild>
                <a href={repoUrl} target="_blank" rel="noreferrer">
                  <GitBranch className="size-4" />
                  Open repository
                </a>
              </DropdownMenuItem>
            </SimpleTooltip>
          )}
          <SimpleTooltip content="Open this app's settings" side="left">
            <DropdownMenuItem asChild>
              <Link href={`/apps/${slug}/settings`} className="cursor-pointer">
                <Settings className="size-4" />
                Settings
              </Link>
            </DropdownMenuItem>
          </SimpleTooltip>
          <SimpleTooltip
            content={tip(
              "move_apps",
              canMove,
              "Hand this app, and everything it owns, to another team",
            )}
            side="left"
          >
            <DropdownMenuItem
              onSelect={() => setTransferOpen(true)}
              disabled={!canMove}
            >
              <ArrowLeftRight className="size-4" />
              Transfer to another team
            </DropdownMenuItem>
          </SimpleTooltip>

          <DropdownMenuSeparator />
          <SimpleTooltip
            content={tip(
              "delete_apps",
              canDelete,
              "Permanently delete this app and its deployments",
            )}
            side="left"
          >
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setDeleteOpen(true)}
              disabled={!canDelete}
            >
              <Trash2 className="size-4" />
              Delete app
            </DropdownMenuItem>
          </SimpleTooltip>
        </DropdownMenuContent>
      </DropdownMenu>

      <TransferTeamDialog
        open={transferOpen}
        onOpenChange={setTransferOpen}
        appId={appId}
        appName={name}
      />
      <DeleteWithArtifacts
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        targetKind="app"
        targetId={appId}
        targetName={name}
        title="Delete app?"
        description={
          <>
            Deleting <strong>{name}</strong> removes it for good.
          </>
        }
        consequence="Its data, deployments, domains, variables and every backup it has stored go with it."
        confirmLabel="Delete app"
        successMessage="App deleted"
        deleteMutation={() =>
          gqlAction(`mutation($id: String!) { deleteApp(id: $id) }`, {
            id: appId,
          })
        }
        onDeleted={() => router.push("/")}
      />
    </>
  );
}
