"use client";

import * as React from "react";
import { CircleAlert, Hammer, XCircle, RotateCw } from "lucide-react";
import { gql } from "@/lib/graphql-client";
import { EmptyState } from "@/components/shared/empty-state";
import { ContainerLogs } from "@/components/apps/container-logs";
import { LogsGraphic } from "@/components/apps/logs-graphic";
import { BuildLogStream } from "@/components/apps/build-log-stream";
import { useLiveApp } from "@/components/apps/app-live-status";
import {
  useAppRuntime,
  type AppRuntimeView,
} from "@/components/apps/use-app-runtime";
import type { LogNotice } from "@/components/logs/log-notice";
import type { LogTitle } from "@/components/logs/log-title";
import type { ConsoleInstance } from "@/lib/data/console";
import type { DeploymentStatus, LogLine } from "@/lib/types";

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

/** The most recent build for an app — the source of the build logs the page
 *  falls back to when the app has no container at all. */
type LatestDeployment = { id: string; status: DeploymentStatus };

/**
 * Logs page body.
 *
 * It streams runtime logs whenever a container EXISTS on the host — running,
 * restarting, or long dead — and falls back to the last build's logs only when
 * there is no container to read from. It used to gate the stream on "the app is
 * running", which hid the logs in the one case where they matter most: a
 * crash-looping container is never in state "running", so the page sat on a
 * spinner (or showed a stale build log) while `docker logs` on the host printed
 * the stack trace that explained the crash. `docker logs` reads the container's
 * log file, which outlives the process — a dead container still has plenty to say.
 */
export function LiveLogs({
  appId,
  title,
  initialInstances,
  initialStreamable,
  initialSupportsTimeline,
  initialLogMaxDays,
  latestDeployment,
  initialBuildLogs,
}: {
  appId: string;
  /** The App's name and the way back to its Overview. The full-screen route has
   *  no page title and no app header, so the toolbar carries both. */
  title: LogTitle;
  initialInstances: ConsoleInstance[];
  initialStreamable: boolean;
  /** The owning host's agent honours a log time window (`logs.timerange`). */
  initialSupportsTimeline: boolean;
  /** The instance ceiling on that window, in days. */
  initialLogMaxDays: number;
  latestDeployment: LatestDeployment | null;
  initialBuildLogs: LogLine[];
}) {
  const live = useLiveApp();
  const [instances, setInstances] =
    React.useState<ConsoleInstance[]>(initialInstances);
  const [streamable, setStreamable] = React.useState(initialStreamable);
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
  // state (deploy / start / stop): a redeploy replaces the containers, so the
  // names we stream from must be re-resolved. The runtime poll above tracks the
  // container's own comings and goings, which need no refetch.
  const liveStatus = live?.status;
  React.useEffect(() => {
    let cancelled = false;
    gql<LogsInfoResponse>(LOGS_INFO_QUERY, { appId })
      .then((data) => {
        if (cancelled) return;
        const li = data.logsInfo;
        if (!li) return;
        setStreamable(li.streamable);
        setSupportsTimeline(li.supportsTimeline);
        setLogMaxDays(li.logMaxDays);
        if (li.instances.length) setInstances(li.instances);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [appId, liveStatus]);

  if (streamable && instances.length) {
    return (
      <ContainerLogs
        appId={appId}
        instances={instances}
        runtime={runtime}
        notice={runtimeNotice(runtime)}
        title={title}
        supportsTimeline={supportsTimeline}
        logMaxDays={logMaxDays}
      />
    );
  }

  // No container on the host at all (never deployed, or the stack was torn
  // down): keep the page useful with the most recent build's logs rather than a
  // dead end. Prefer the live subscription's latest deployment (so a redeploy
  // started while viewing this page swaps in the new build's logs, no reload).
  const seededId = latestDeployment?.id ?? null;
  const depId = live?.latestDeploymentId ?? seededId;
  const depStatus =
    live?.latestDeploymentStatus ?? latestDeployment?.status ?? null;

  if (depId && depStatus) {
    return (
      <BuildLogStream
        // Keyed by id so a redeploy remounts against the new build cleanly
        // (fresh log buffer, its own polling) rather than appending to the old.
        key={depId}
        deploymentId={depId}
        initialLogs={depId === seededId ? initialBuildLogs : []}
        initialStatus={depStatus}
        notice={noticeForStatus(depStatus)}
        title={title}
        fill
      />
    );
  }

  // Centred in the full-bleed frame rather than pinned to its top edge, which
  // for an empty state in a viewport-tall pane reads as a page that failed to
  // load the rest of itself.
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <EmptyState
        graphic={<LogsGraphic />}
        title="No logs yet"
        description="Runtime logs stream from the app's container, and this app hasn't been deployed yet. Deploy it to see its build and runtime output here."
      />
    </div>
  );
}

/**
 * What the log pane's notice chip says when the container is NOT healthy. It
 * exists so the output below is never read as "everything is fine" — and so a
 * crash loop is named as a crash loop, since the logs alone (a stack trace
 * repeating every 60 seconds) leave the user to infer it.
 *
 * A descriptor rather than a component: the full-screen logs page has no room
 * above the pane for a banner, so `LogNoticeChip` renders this in the toolbar
 * instead, headline visible and paragraph one click away.
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

/**
 * What the chip says when the pane is showing BUILD logs because the app has no
 * container to stream from — so the output is never mistaken for the live
 * runtime stream. Wording follows the most recent build's status.
 */
export function noticeForStatus(status: DeploymentStatus): LogNotice {
  switch (status) {
    case "building":
    case "queued":
      return {
        tone: "warn",
        icon: Hammer,
        short: "Build in progress",
        title: "Build in progress, no container yet",
        body: "Showing this build's logs. Live runtime logs will stream here as soon as the container exists.",
      };
    case "error":
      return {
        tone: "error",
        icon: XCircle,
        short: "Build failed",
        title: "The last build failed, so no container was created",
        body: "Showing the failed build's logs. Fix the errors and redeploy to bring the app up.",
      };
    case "canceled":
      return {
        tone: "muted",
        icon: CircleAlert,
        short: "Build canceled",
        title: "The last build was canceled, so no container was created",
        body: "Showing the canceled build's logs. Redeploy to build and start the app.",
      };
    default:
      return {
        tone: "muted",
        icon: CircleAlert,
        short: "Build logs",
        title: "This app has no container on its server",
        body: "Showing the most recent build's logs. These are not live: deploy the app to stream its runtime output.",
      };
  }
}
