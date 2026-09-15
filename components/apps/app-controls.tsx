"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Play, Square, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import {
  useLiveStatus,
  useNeverDeployed,
} from "@/components/apps/app-live-status";
import { CapabilityTip, useAppCan } from "@/components/apps/app-capabilities";
import type { AppStatus } from "@/lib/types/app";

export function AppControls({
  appId,
  status: serverStatus,
}: {
  appId: string;
  status: AppStatus;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const status = useLiveStatus(serverStatus);
  const neverDeployed = useNeverDeployed();
  const can = useAppCan("control_apps");
  const stopped = status === "idle";
  const stopping = status === "stopping";
  const restoring = status === "restoring";

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

  const [reloading, setReloading] = React.useState(false);
  function reload() {
    setReloading(true);
    startTransition(async () => {
      try {
        const res = await gqlAction<{ reloadApp: string | null }, string>(
          `mutation($id: String!) { reloadApp(id: $id) }`,
          { id: appId },
          (d) => d.reloadApp ?? "",
        );
        if (!res.ok) {
          toast.error(res.error);
          return;
        }
        const status = res.data;
        toast.success(
          status === "rerouted"
            ? "Routing reloaded"
            : status === "unchanged"
              ? "Already up to date"
              : "Saved - applies on the next deploy",
        );
        router.refresh();
      } finally {
        setReloading(false);
      }
    });
  }

  if (neverDeployed) return null;

  if (!can) {
    return (
      <>
        <CapabilityTip cap="control_apps">
          <Button variant="outline" size="sm" disabled>
            {stopped ? (
              <Play className="size-4" />
            ) : (
              <Square className="size-4" />
            )}
            {stopped ? "Start" : "Stop"}
          </Button>
        </CapabilityTip>
        <CapabilityTip cap="control_apps">
          <Button variant="outline" size="sm" disabled>
            <RefreshCw className="size-4" />
            Reload
          </Button>
        </CapabilityTip>
      </>
    );
  }

  return (
    <>
      {restoring ? (
        <Button variant="outline" size="sm" disabled>
          <Loader2 className="size-4 animate-spin" />
          Restoring
        </Button>
      ) : stopped ? (
        <SimpleTooltip content="Start this app's stopped container">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              act(
                `mutation($id: String!) { startApp(id: $id) { id } }`,
                "Container started",
              )
            }
          >
            <Play className="size-4" />
            Start
          </Button>
        </SimpleTooltip>
      ) : stopping ? (
        <Button variant="outline" size="sm" disabled>
          <Loader2 className="size-4 animate-spin" />
          Stopping
        </Button>
      ) : (
        <SimpleTooltip content="Stop this app's running container">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              act(
                `mutation($id: String!) { stopApp(id: $id) { id } }`,
                "Container stopped",
              )
            }
          >
            <Square className="size-4" />
            Stop
          </Button>
        </SimpleTooltip>
      )}
      <SimpleTooltip content="Re-apply domains and basic auth to the running container, no rebuild">
        <Button
          variant="outline"
          size="sm"
          onClick={reload}
          disabled={restoring || reloading}
        >
          <RefreshCw className={cn("size-4", reloading && "animate-spin")} />
          Reload
        </Button>
      </SimpleTooltip>
    </>
  );
}
