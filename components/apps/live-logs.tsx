"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { CircleAlert, Play, RotateCw, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { useRouter } from "@/lib/nav";
import { gql, gqlAction } from "@/lib/graphql-client";
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
import { RESTART_LOOP_THRESHOLD } from "@/lib/monitoring/restart-loop";
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
  title?: PaneTitle;
  initialInstances: ConsoleInstance[];
  initialStreamable: boolean;
  initialUnreachable: boolean;
  initialSupportsTimeline: boolean;
  initialLogMaxDays: number;
  deploymentsHref: string;
  toolbar?: React.ReactNode;
}) {
  const live = useLiveApp();
  const [instances, setInstances] =
    React.useState<ConsoleInstance[]>(initialInstances);
  const [streamable, setStreamable] = React.useState(initialStreamable);
  const [unreachable, setUnreachable] = React.useState(initialUnreachable);
  const [supportsTimeline, setSupportsTimeline] = React.useState(
    initialSupportsTimeline,
  );
  const [logMaxDays, setLogMaxDays] = React.useState(initialLogMaxDays);

  const runtime = useAppRuntime(appId);

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

  if (!streamable || instances.length === 0) {
    const depId = live?.latestDeploymentId ?? null;
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-2">
          <ScrollText className="size-4 shrink-0 text-muted-foreground" />
          <PaneTitleLink title={title} />
          {toolbar}
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <EmptyState
            graphic={<LogsGraphic />}
            title="No logs yet"
            docs="logs.overview"
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
      notice={runtimeNotice(runtime, {
        stoppedAt: live?.restartLoopStoppedAt,
        action: <StartAfterLoopButton appId={appId} />,
      })}
      title={title}
      toolbar={toolbar}
      supportsTimeline={supportsTimeline}
      logMaxDays={logMaxDays}
    />
  );
}

function StartAfterLoopButton({ appId }: { appId: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await gqlAction(
            /* GraphQL */ `
              mutation ($id: String!) {
                startApp(id: $id) {
                  id
                }
              }
            `,
            { id: appId },
          );
          if (res.ok) {
            toast.success("Container started");
            router.refresh();
          } else toast.error(res.error);
        })
      }
    >
      <Play className="size-4" />
      Start
    </Button>
  );
}

export function runtimeNotice(
  runtime: AppRuntimeView | null,
  guard?: { stoppedAt?: string | null; action?: React.ReactNode },
): LogNotice | null {
  if (!runtime || runtime.unreachable || runtime.total === 0) return null;

  // Outranks every other notice: it is the most specific thing that happened.
  if (guard?.stoppedAt && runtime.running < runtime.total) {
    return {
      tone: "error",
      icon: RotateCw,
      short: "Stopped",
      title: `Deplo stopped this container after ${RESTART_LOOP_THRESHOLD} restarts`,
      body: `It crashed ${RESTART_LOOP_THRESHOLD} times in half an hour, so Deplo stopped retrying. The error that kills it is in the output below.`,
      action: guard.action,
    };
  }

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
