"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
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
import type { AppStatus } from "@/lib/types/app";

export type AppLifecycleState =
  "never-deployed" | "restoring" | "stopping" | "stopped" | "running";

// One state and one set of mutations for both presentations: the header buttons and the kebab.
export function useAppLifecycle(appId: string, serverStatus: AppStatus) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const status = useLiveStatus(serverStatus);
  const neverDeployed = useNeverDeployed();
  const canControl = useAppCan("control_apps");

  const state: AppLifecycleState = neverDeployed
    ? "never-deployed"
    : status === "restoring"
      ? "restoring"
      : status === "stopping"
        ? "stopping"
        : status === "idle"
          ? "stopped"
          : "running";

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

  return {
    state,
    pending,
    canControl,
    start: () =>
      act(
        `mutation($id: String!) { startApp(id: $id) { id } }`,
        "Container started",
      ),
    stop: () =>
      act(
        `mutation($id: String!) { stopApp(id: $id) { id } }`,
        "Container stopped",
      ),
    reload,
  };
}

function BusyButton({ label, tip }: { label: string; tip: string }) {
  return (
    <SimpleTooltip content={tip}>
      <span className="inline-flex cursor-not-allowed">
        <Button variant="outline" size="sm" disabled>
          <Loader2 className="size-4 animate-spin" />
          {label}
        </Button>
      </span>
    </SimpleTooltip>
  );
}

// An app that builds no image of its own has nothing to roll back to, so its header gets these.
export function AppLifecycleButtons({
  appId,
  status,
}: {
  appId: string;
  status: AppStatus;
}) {
  const { state, pending, canControl, start, stop, reload } = useAppLifecycle(
    appId,
    status,
  );
  if (state === "never-deployed") return null;

  const stopped = state === "stopped";
  const Icon = pending ? Loader2 : stopped ? Play : Square;
  const power =
    state === "restoring" ? (
      <BusyButton
        label="Restoring"
        tip="A backup is being restored into this app"
      />
    ) : state === "stopping" ? (
      <BusyButton label="Stopping" tip="The container is currently stopping" />
    ) : !canControl ? (
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
    ) : (
      <SimpleTooltip
        content={
          stopped
            ? "Start this app's stopped container"
            : "Stop this app's running container"
        }
      >
        <Button
          variant="outline"
          size="sm"
          onClick={stopped ? start : stop}
          disabled={pending}
        >
          <Icon className={pending ? "size-4 animate-spin" : "size-4"} />
          {stopped ? "Start" : "Stop"}
        </Button>
      </SimpleTooltip>
    );

  return (
    <>
      {power}
      {canControl ? (
        <SimpleTooltip content="Re-apply domains and basic auth to the running container, no rebuild">
          <Button
            variant="outline"
            size="sm"
            onClick={reload}
            disabled={pending || state === "restoring"}
          >
            <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} />
            Reload
          </Button>
        </SimpleTooltip>
      ) : (
        <CapabilityTip cap="control_apps">
          <Button variant="outline" size="sm" disabled>
            <RefreshCw className="size-4" />
            Reload
          </Button>
        </CapabilityTip>
      )}
    </>
  );
}
