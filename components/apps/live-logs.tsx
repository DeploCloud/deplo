"use client";

import * as React from "react";
import Link from "next/link";
import { CircleAlert, RotateCw, ScrollText } from "lucide-react";
import { gql } from "@/lib/graphql-client";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { ContainerLogs } from "@/components/apps/container-logs";
import { LogsGraphic } from "@/components/apps/logs-graphic";
import { useLiveApp } from "@/components/apps/app-live-status";
import {
  useAppRuntime,
  type AppRuntimeView,
} from "@/components/apps/use-app-runtime";
import type { LogNotice } from "@/components/logs/log-notice";
import { PaneTitleLink, type PaneTitle } from "@/components/shared/pane-title";
import type { ConsoleInstance } from "@/lib/data/console";

const LOGS_INFO_QUERY = /* GraphQL */ `
  query LogsInfo($appId: String!) {
    logsInfo(appId: $appId) {
      running
      streamable
      unreachable
      supportsTimeline
      logMaxDays
      instances {
        name
        service
        image
        running
        exposed
        user
        workdir
        openStdin
        tty
      }
    }
  }
`;

type LogsInfoResponse = {
  logsInfo: {
    running: boolean;
    streamable: boolean;
    unreachable: boolean;
    supportsTimeline: boolean;
    logMaxDays: number;
    instances: ConsoleInstance[];
  } | null;
};

/**
 * Logs page body: an App's RUNTIME logs, and nothing else.
 */
export function LiveLogs({
  appId,
  title,
  initialInstances,
  initialStreamable,
  initialUnreachable,
  initialSupportsTimeline,
  initialLogMaxDays,
  deploymentsHref,
  toolbar,
}: {
  appId: string;
  /**
   * The App's name and the way back to its Overview. Omitted on the general Logs
   * page, where the target picker in `toolbar` shows the name itself and drawing
   * this too would say it twice.
   */
  title?: PaneTitle;
  initialInstances: ConsoleInstance[];
  initialStreamable: boolean;
  /** The owning agent could not be reached, so `initialStreamable` is false for
   *  a reason that has nothing to do with whether a container exists. */
  initialUnreachable: boolean;
  /** The owning host's agent honours a log time window (`logs.timerange`). */
  initialSupportsTimeline: boolean;
  /** The instance ceiling on that window, in days. */
  initialLogMaxDays: number;
  /** This app's deployment list (`/apps/<slug>/deployments`) — where the empty
   *  state sends somebody whose app has no container yet, to read the build. */
  deploymentsHref: string;
  /** Extra toolbar controls. The general Logs page passes its target picker;
   *  the App's own Logs tab passes nothing. */
  toolbar?: React.ReactNode;
}) {
  const live = useLiveApp();
  const [instances, setInstances] =
    React.useState<ConsoleInstance[]>(initialInstances);
  const [streamable, setStreamable] = React.useState(initialStreamable);
  // Why `streamable` is false, which the empty state has to say out loud: an
  // unreachable agent is transient and NOT the same as no container.
  const [unreachable, setUnreachable] = React.useState(initialUnreachable);
  // Both follow the same refetch as `streamable`: moving the app to another
  // server, or updating that server's agent, changes whether the window is
  // honoured, and the control must not keep offering one the host ignores.
  const [supportsTimeline, setSupportsTimeline] = React.useState(
    initialSupportsTimeline,
  );
  const [logMaxDays, setLogMaxDays] = React.useState(initialLogMaxDays);

  // What the containers are really doing — drives the banner above the stream
  // and tells a crash loop apart from a container that has simply stopped.
  const runtime = useAppRuntime(appId);

  // Re-read the instance list whenever the control plane changes the app's power
  // state (deploy / start / stop): a redeploy replaces the containers, so the names
  // we stream from must be re-resolved.
  const liveStatus = live?.status;
  React.useEffect(() => {
    let cancelled = false;
    gql<LogsInfoResponse>(LOGS_INFO_QUERY, { appId })
      .then((data) => {
        if (cancelled) return;
        const li = data.logsInfo;
        if (!li) return;
        setStreamable(li.streamable);
        setUnreachable(li.unreachable);
        setSupportsTimeline(li.supportsTimeline);
        setLogMaxDays(li.logMaxDays);
        if (li.instances.length) setInstances(li.instances);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [appId, liveStatus]);

  // Nothing on the host to stream from.
  if (!streamable || instances.length === 0) {
    // The build to offer is the LIVE one, so a redeploy started while this is on
    // screen points at the run that is actually happening.
    const depId = live?.latestDeploymentId ?? null;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-secondary/40 px-3 py-2">
          <ScrollText className="size-4 shrink-0 text-muted-foreground" />
          <PaneTitleLink title={title} />
          {toolbar}
        </div>
        {/* Centred in what is left of the full-bleed frame rather than pinned to
            its top edge, which in a viewport-tall pane reads as a page that
            failed to load the rest of itself. */}
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState
            graphic={<LogsGraphic />}
            title="No logs yet"
            description={
              unreachable
                ? "Can't reach the server this app runs on, so there's nothing to stream."
                : "This app has no container on its server yet, so there's nothing to stream."
            }
            action={
              depId ? (
                <Button asChild>
                  <Link href={`${deploymentsHref}/${depId}`}>
                    View build logs
                  </Link>
                </Button>
              ) : null
            }
          />
        </div>
      </div>
    );
  }

  return (
    <ContainerLogs
      appId={appId}
      instances={instances}
      runtime={runtime}
      notice={runtimeNotice(runtime)}
      title={title}
      toolbar={toolbar}
      supportsTimeline={supportsTimeline}
      logMaxDays={logMaxDays}
    />
  );
}

/**
 * What the log pane's notice chip says when the container is NOT healthy.
 */
export function runtimeNotice(
  runtime: AppRuntimeView | null,
): LogNotice | null {
  if (!runtime || runtime.unreachable || runtime.total === 0) return null;

  if (runtime.missing.length > 0) {
    return {
      tone: "error",
      icon: CircleAlert,
      short: "No container",
      title: `${runtime.missing.join(", ")} has no container on the host`,
      body: "The rest of the stack is up, but this service was never created (or was removed), so it has no logs of its own. Redeploy the app to bring it back.",
    };
  }
  if (runtime.restarting > 0) {
    const restarts = Math.max(
      ...runtime.containers.map((c) => c.restartCount),
      0,
    );
    return {
      tone: "warn",
      icon: RotateCw,
      iconClass: "animate-spin [animation-duration:3s]",
      short: restarts > 0 ? `${restarts} restarts` : "Restart loop",
      title:
        restarts > 0
          ? `This container is in a restart loop (${restarts} restarts)`
          : "This container is in a restart loop",
      body: "Docker starts it, it dies, and Docker starts it again. The output below is its live log across those restarts: the error that kills it is in there.",
    };
  }
  if (runtime.unhealthy > 0) {
    return {
      tone: "warn",
      icon: CircleAlert,
      short: "Unhealthy",
      title: "This container is running but failing its healthcheck",
      body: "The process is up and Docker's healthcheck says it is not working. The output below is live, so whatever the check is failing on should be in it.",
    };
  }
  if (runtime.running === 0) {
    return {
      tone: "error",
      icon: CircleAlert,
      short: "Not running",
      title: "This container is not running",
      body: "The app is deployed but nothing is up on the host. Below is the output the container produced before it stopped.",
    };
  }
  if (runtime.running < runtime.total) {
    return {
      tone: "warn",
      icon: CircleAlert,
      short: `${runtime.running}/${runtime.total} up`,
      title: `Only ${runtime.running} of ${runtime.total} containers are running`,
      body: "Part of this stack is down. Switch containers with the picker in the toolbar to read the one that stopped.",
    };
  }
  return null;
}
