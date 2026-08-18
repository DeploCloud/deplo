"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Play, Square, RefreshCw, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import {
  useLiveStatus,
  useNeverDeployed,
} from "@/components/apps/app-live-status";
import { CapabilityTip, useAppCan } from "@/components/apps/app-capabilities";
import type { AppStatus } from "@/lib/types";

export function AppControls({
  appId,
  status: serverStatus,
}: {
  appId: string;
  status: AppStatus;
}) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  // Live status (subscription) takes precedence over the server-rendered value
  // so the button reflects start/stop/deploy in real time — and the "Stopping"
  // label is driven by the persisted "stopping" status, so it survives reload
  // and every viewer sees it, not just the user who clicked.
  const status = useLiveStatus(serverStatus);
  // Nothing has ever been built for this app, so there is no container to start,
  // stop or reroute — every control here would dial the host for a stack that is
  // not there. The header's Deploy button is the only thing that can act on it,
  // and it stands alone until the first build lands.
  const neverDeployed = useNeverDeployed();
  // Start / Stop / Reload are all one permission. Without it every button here
  // is disabled rather than hidden, so the app still reads as an app - it just
  // isn't this viewer's to power on and off.
  const can = useAppCan("control_apps");
  const stopped = status === "idle";
  const stopping = status === "stopping";
  // A backup is being put back in place: the stack is coming down and back up
  // under Deplo's hand, so powering it on or off from here is not an option the
  // app has right now.
  const restoring = status === "restoring";

  // Fire and let the STATUS answer: the persisted `stopping` / `restoring`
  // states and the live subscription already say what the container is doing,
  // so holding the button in a spinner adds nothing but a delay.
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

  if (neverDeployed) return null;

  if (!can) {
    return (
      <>
        <CapabilityTip cap="control_apps">
          <Button variant="outline" size="sm" disabled>
            {stopped ? <Play className="size-4" /> : <Square className="size-4" />}
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
        // Persisted transient state, same contract as "Stopping": the button is
        // disabled and self-clears when the restore settles the status.
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
          disabled={restoring}
        >
          <RefreshCw className="size-4" />
          Reload
        </Button>
      </SimpleTooltip>
    </>
  );
}
