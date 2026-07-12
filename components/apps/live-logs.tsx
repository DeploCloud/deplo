"use client";

import * as React from "react";
import { ScrollText, CircleAlert, Hammer, Loader2, XCircle } from "lucide-react";
import { gql } from "@/lib/graphql-client";
import { EmptyState } from "@/components/shared/empty-state";
import { ContainerLogs } from "@/components/services/container-logs";
import { BuildLogStream } from "@/components/services/build-log-stream";
import {
  useLiveRunning,
  useLiveService,
} from "@/components/services/service-live-status";
import { cn } from "@/lib/utils";
import type { ConsoleInstance } from "@/lib/data/console";
import type { DeploymentStatus, LogLine } from "@/lib/types";

const LOGS_INFO_QUERY = /* GraphQL */ `
  query LogsInfo($serviceId: String!) {
    logsInfo(serviceId: $serviceId) {
      running
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
  logsInfo: { running: boolean; instances: ConsoleInstance[] } | null;
};

/** The most recent build for a service — the source of the build logs the page
 *  falls back to whenever there's no running container to stream from. */
type LatestDeployment = { id: string; status: DeploymentStatus };

/**
 * Logs page body that follows the service's live running state. While the
 * container is running it streams live runtime logs; the moment it stops (or
 * before it has ever started) it falls back — without a reload — to the most
 * recent build's logs, clearly flagged as not live. This keeps the Logs page
 * useful for a stopped project instead of hiding it behind a "not running"
 * dead end. On a live start it fetches the instance list (a stopped project has
 * none server-rendered) so the log viewer can attach.
 */
export function LiveLogs({
  serviceId,
  initialInstances,
  initialRunning,
  latestDeployment,
  initialBuildLogs,
}: {
  serviceId: string;
  initialInstances: ConsoleInstance[] | null;
  initialRunning: boolean;
  latestDeployment: LatestDeployment | null;
  initialBuildLogs: LogLine[];
}) {
  const running = useLiveRunning(initialRunning);
  const live = useLiveService();
  // Instance list for the current running session. Seeded from SSR, re-fetched
  // on each transition into running. Display is gated on `running`, so it is
  // never nulled on stop (just ignored) — all writes stay in async callbacks.
  const [instances, setInstances] = React.useState<ConsoleInstance[] | null>(
    initialRunning ? initialInstances : null,
  );

  React.useEffect(() => {
    if (!running) return;
    let cancelled = false;
    gql<LogsInfoResponse>(LOGS_INFO_QUERY, { serviceId })
      .then((data) => {
        if (cancelled) return;
        const li = data.logsInfo;
        setInstances(li?.running ? li.instances : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [running, serviceId]);

  // Container running (control-plane truth) → live runtime logs. We never show
  // the "not live / stopped" build-logs fallback while running: until the
  // instance probe resolves we show a brief attaching state instead, so the
  // banner can't momentarily contradict a green/running header.
  if (running) {
    return instances ? (
      <ContainerLogs serviceId={serviceId} instances={instances} />
    ) : (
      <EmptyState
        icon={Loader2}
        iconClassName="animate-spin"
        title="Connecting to the container…"
        description="The project is running — attaching to its live log stream."
      />
    );
  }

  // Not running: keep the page useful by showing the most recent build's logs
  // rather than hiding everything behind an empty state. Prefer the live
  // subscription's latest deployment (so a redeploy started while viewing this
  // page swaps in the new build's logs, no reload) and fall back to the
  // server-rendered seed for the very first paint.
  const seededId = latestDeployment?.id ?? null;
  const depId = live?.latestDeploymentId ?? seededId;
  const depStatus = live?.latestDeploymentStatus ?? latestDeployment?.status ?? null;

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
      description="Runtime logs stream from a running container, and this project hasn't been deployed yet. Deploy it to see its build and runtime output here."
    />
  );
}

/**
 * Banner shown above the build logs when the container isn't running, so the
 * user knows the output isn't the live runtime stream. Wording follows the most
 * recent build's status: an in-progress build is genuinely live output, a
 * failed/canceled build never came up, and an otherwise-terminal build means the
 * project is simply stopped.
 */
function StoppedLogsNotice({ status }: { status: DeploymentStatus }) {
  const notice = noticeForStatus(status);
  const Icon = notice.icon;
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/40 px-3.5 py-2.5 text-sm">
      <Icon className={cn("mt-0.5 size-4 shrink-0", notice.iconClass)} />
      <div className="space-y-0.5">
        <p className="font-medium">{notice.title}</p>
        <p className="text-muted-foreground">{notice.body}</p>
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
        title: "Build in progress — the container isn't running yet",
        body: "Showing this build's logs below. Live runtime logs will stream here once the container is running.",
      };
    case "error":
      return {
        icon: XCircle,
        iconClass: "text-destructive",
        title: "The last build failed — the project isn't running",
        body: "Showing the failed build's logs below. Fix the errors and redeploy to bring the project up.",
      };
    case "canceled":
      return {
        icon: CircleAlert,
        iconClass: "text-muted-foreground",
        title: "The last build was canceled — the project isn't running",
        body: "Showing the canceled build's logs below. Redeploy to build and start the project.",
      };
    default:
      return {
        icon: CircleAlert,
        iconClass: "text-muted-foreground",
        title: "This project is stopped — live runtime logs aren't available",
        body: "Showing the most recent build's logs below. These are not live — start the project to stream its runtime output.",
      };
  }
}
