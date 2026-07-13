"use client";

import * as React from "react";
import { ScrollText, CircleAlert, Hammer, XCircle, RotateCw } from "lucide-react";
import { gql } from "@/lib/graphql-client";
import { EmptyState } from "@/components/shared/empty-state";
import { ContainerLogs } from "@/components/apps/container-logs";
import { BuildLogStream } from "@/components/apps/build-log-stream";
import { useLiveApp } from "@/components/apps/app-live-status";
import {
  useAppRuntime,
  type AppRuntimeView,
} from "@/components/apps/use-app-runtime";
import { cn } from "@/lib/utils";
import type { ConsoleInstance } from "@/lib/data/console";
import type { DeploymentStatus, LogLine } from "@/lib/types";

const LOGS_INFO_QUERY = /* GraphQL */ `
  query LogsInfo($appId: String!) {
    logsInfo(appId: $appId) {
      running
      streamable
      unreachable
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
  initialInstances,
  initialStreamable,
  latestDeployment,
  initialBuildLogs,
}: {
  appId: string;
  initialInstances: ConsoleInstance[];
  initialStreamable: boolean;
  latestDeployment: LatestDeployment | null;
  initialBuildLogs: LogLine[];
}) {
  const live = useLiveApp();
  const [instances, setInstances] =
    React.useState<ConsoleInstance[]>(initialInstances);
  const [streamable, setStreamable] = React.useState(initialStreamable);

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
        if (li.instances.length) setInstances(li.instances);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [appId, liveStatus]);

  if (streamable && instances.length) {
    return (
      <div className="space-y-4">
        <RuntimeNotice runtime={runtime} />
        <ContainerLogs appId={appId} instances={instances} runtime={runtime} />
      </div>
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
      <div className="space-y-4">
        <StoppedLogsNotice status={depStatus} />
        <BuildLogStream
          // Keyed by id so a redeploy remounts against the new build cleanly
          // (fresh log buffer, its own polling) rather than appending to the old.
          key={depId}
          deploymentId={depId}
          initialLogs={depId === seededId ? initialBuildLogs : []}
          initialStatus={depStatus}
        />
      </div>
    );
  }

  return (
    <EmptyState
      icon={ScrollText}
      title="No logs yet"
      description="Runtime logs stream from the app's container, and this project hasn't been deployed yet. Deploy it to see its build and runtime output here."
    />
  );
}

/**
 * The banner above a live stream whose container is NOT healthy. It exists so the
 * output below is never read as "everything is fine" — and so a crash loop is
 * named as a crash loop, since the logs alone (a stack trace repeating every 60
 * seconds) leave the user to infer it.
 */
function RuntimeNotice({ runtime }: { runtime: AppRuntimeView | null }) {
  if (!runtime || runtime.unreachable || runtime.total === 0) return null;

  if (runtime.missing.length > 0) {
    return (
      <Notice
        icon={CircleAlert}
        iconClass="text-destructive"
        title={`${runtime.missing.join(", ")} has no container on the host`}
        body="The rest of the stack is up, but this service was never created (or was removed), so it has no logs of its own. Redeploy the app to bring it back."
      />
    );
  }
  if (runtime.restarting > 0) {
    return (
      <Notice
        icon={RotateCw}
        iconClass="text-[var(--warning)] animate-spin [animation-duration:3s]"
        title="This container is in a restart loop"
        body="Docker starts it, it dies, and Docker starts it again. The output below is its live log across those restarts — the error that kills it is in there."
      />
    );
  }
  if (runtime.running === 0) {
    return (
      <Notice
        icon={CircleAlert}
        iconClass="text-destructive"
        title="This container is not running"
        body="The app is deployed but nothing is up on the host. Below is the output the container produced before it stopped."
      />
    );
  }
  if (runtime.running < runtime.total) {
    return (
      <Notice
        icon={CircleAlert}
        iconClass="text-[var(--warning)]"
        title={`Only ${runtime.running} of ${runtime.total} containers are running`}
        body="Part of this stack is down. Switch containers with the picker below to read the one that stopped."
      />
    );
  }
  return null;
}

/**
 * Banner shown above the build logs when the app has no container to stream from,
 * so the user knows the output isn't the live runtime stream. Wording follows the
 * most recent build's status.
 */
function StoppedLogsNotice({ status }: { status: DeploymentStatus }) {
  const notice = noticeForStatus(status);
  return (
    <Notice
      icon={notice.icon}
      iconClass={notice.iconClass}
      title={notice.title}
      body={notice.body}
    />
  );
}

function Notice({
  icon: Icon,
  iconClass,
  title,
  body,
}: {
  icon: typeof CircleAlert;
  iconClass: string;
  title: string;
  body: string;
}) {
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/40 px-3.5 py-2.5 text-sm">
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconClass)} />
      <div className="space-y-0.5">
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}

function noticeForStatus(status: DeploymentStatus): {
  icon: typeof CircleAlert;
  iconClass: string;
  title: string;
  body: string;
} {
  switch (status) {
    case "building":
    case "queued":
      return {
        icon: Hammer,
        iconClass: "text-[var(--warning)]",
        title: "Build in progress — no container yet",
        body: "Showing this build's logs below. Live runtime logs will stream here as soon as the container exists.",
      };
    case "error":
      return {
        icon: XCircle,
        iconClass: "text-destructive",
        title: "The last build failed — no container was created",
        body: "Showing the failed build's logs below. Fix the errors and redeploy to bring the project up.",
      };
    case "canceled":
      return {
        icon: CircleAlert,
        iconClass: "text-muted-foreground",
        title: "The last build was canceled — no container was created",
        body: "Showing the canceled build's logs below. Redeploy to build and start the project.",
      };
    default:
      return {
        icon: CircleAlert,
        iconClass: "text-muted-foreground",
        title: "This project has no container on its server",
        body: "Showing the most recent build's logs below. These are not live — deploy the project to stream its runtime output.",
      };
  }
}
