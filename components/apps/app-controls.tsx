"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Play, Square, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import { useLiveStatus } from "@/components/apps/app-live-status";
import type { AppStatus } from "@/lib/types";

export function AppControls({
  appId,
  status: serverStatus,
}: {
  appId: string;
  status: AppStatus;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  // Live status (subscription) takes precedence over the server-rendered value
  // so the button reflects start/stop/deploy in real time — and the "Stopping"
  // label is driven by the persisted "stopping" status, so it survives reload
  // and every viewer sees it, not just the user who clicked.
  const status = useLiveStatus(serverStatus);
  const stopped = status === "idle";
  const stopping = status === "stopping";

  function act(mutation: string, success: string) {
    startTransition(async () => {
      const res = await gqlAction(mutation, { id: appId });
      if (res.ok) {
        toast.success(success);
        // The subscription pushes the new status, but refresh the RSC tree too
        // so any server-rendered, non-subscribed bits stay consistent.
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  // Reload re-applies the app's routing (domains + basic auth) to the running
  // container WITHOUT a rebuild. The mutation returns a status string we turn
  // into an honest toast — "deferred" means nothing was running to reroute.
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
      const status = res.data;
      toast.success(
        status === "rerouted"
          ? "Routing reloaded"
          : status === "unchanged"
            ? "Already up to date"
            : "Saved — applies on the next deploy",
      );
      router.refresh();
    });
  }

  return (
    <>
      {stopped ? (
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
            disabled={pending}
          >
            <Play className="size-4" />
            Start
          </Button>
        </SimpleTooltip>
      ) : stopping ? (
        // Persisted transient state: the container is being brought down. The
        // button is disabled and self-clears when the status settles to "idle".
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
            disabled={pending}
          >
            <Square className="size-4" />
            Stop
          </Button>
        </SimpleTooltip>
      )}
      <SimpleTooltip content="Re-apply domains and basic auth to the running container — no rebuild">
        <Button
          variant="outline"
          size="sm"
          onClick={reload}
          disabled={pending}
        >
          <RefreshCw className="size-4" />
          Reload
        </Button>
      </SimpleTooltip>
    </>
  );
}
