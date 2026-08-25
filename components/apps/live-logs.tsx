"use client";

import * as React from "react";
import {
  Activity,
  CircleAlert,
  Hammer,
  ScrollText,
  XCircle,
  RotateCw,
} from "lucide-react";
import { gql } from "@/lib/graphql-client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SimpleTooltip } from "@/components/ui/tooltip";
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
import { PaneTitleLink, type PaneTitle } from "@/components/shared/pane-title";
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
 * Logs page body: an App's two log sources, with a switch between them.
 *
 * **Runtime** streams from the container whenever one EXISTS on the host —
 * running, restarting, or long dead. It used to gate on "the app is running",
 * which hid the logs in the one case where they matter most: a crash-looping
 * container is never in state "running", so the page sat on a spinner while
 * `docker logs` on the host printed the stack trace that explained the crash.
 * `docker logs` reads the container's log file, which outlives the process.
 *
 * **Build** is the latest deployment's build log. This used to be a FALLBACK,
 * reachable only when the app had no container at all — which meant the build
 * logs of a running app could not be opened from here by any route, exactly
 * when somebody is trying to work out why the deploy they just shipped broke
 * it. Now it is a tab, and the fallback survives only as the DEFAULT: with no
 * click, the pane opens on whichever source has something to say.
 *
 * Older builds are deliberately not offered. `/deployments` is the history, and
 * a second picker in this toolbar would duplicate it.
 */
export function LiveLogs({
  appId,
  title,
  initialInstances,
  initialStreamable,
  initialUnreachable,
  initialSupportsTimeline,
  initialLogMaxDays,
  latestDeployment,
  initialBuildLogs,
  toolbar,
}: {
  appId: string;
  /** The App's name and the way back to its Overview. The full-screen route has
   *  no page title and no app header, so the toolbar carries both. Omitted on
   *  the general Logs page, where the target picker in `toolbar` shows the name
   *  itself and drawing this too would say it twice. */
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
  latestDeployment: LatestDeployment | null;
  initialBuildLogs: LogLine[];
  /** Extra toolbar controls to sit beside the Runtime/Build switch. The general
   *  Logs page passes its target picker; the App's own Logs tab passes nothing. */
  toolbar?: React.ReactNode;
}) {
  const live = useLiveApp();
  const [instances, setInstances] =
    React.useState<ConsoleInstance[]>(initialInstances);
  const [streamable, setStreamable] = React.useState(initialStreamable);
  // Why `streamable` is false, which the disabled Runtime tab has to say out
  // loud: an unreachable agent is transient and NOT the same as no container.
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

  // No container on the host at all (never deployed, or the stack was torn
  // down) makes Build the only thing there is to read; a container with no
  // deployment behind it (an image App, an import) makes Runtime the only one.
  // Prefer the live subscription's latest deployment, so a redeploy started
  // while viewing this page swaps in the new build's logs with no reload.
  const seededId = latestDeployment?.id ?? null;
  const depId = live?.latestDeploymentId ?? seededId;
  const depStatus =
    live?.latestDeploymentStatus ?? latestDeployment?.status ?? null;

  const runtimeAvailable = streamable && instances.length > 0;
  const buildAvailable = Boolean(depId && depStatus);

  // An explicit click pins the source; with no click, the pane opens on
  // whichever source has something to say. If the pinned one goes away — the
  // stack is torn down while its runtime logs are on screen — it falls back
  // rather than leaving a dead pane up. Derived, so there is no effect to run
  // and nothing to keep in sync.
  const [chosen, setChosen] = React.useState<Source | null>(null);
  const source: Source =
    chosen === "runtime" && runtimeAvailable
      ? "runtime"
      : chosen === "build" && buildAvailable
        ? "build"
        : runtimeAvailable
          ? "runtime"
          : "build";

  // Nothing to switch between, so no switch is drawn. The toolbar ROW stays,
  // though: on the general Logs page it holds the target picker, and a screen
  // that answers "nothing here" by taking away the only way to look somewhere
  // else is a dead end. It is also the one heading a full-bleed route has.
  if (!runtimeAvailable && !buildAvailable) {
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
            description="Runtime logs stream from the app's container, and this app hasn't been deployed yet. Deploy it to see its build and runtime output here."
          />
        </div>
      </div>
    );
  }

  const controls = (
    <>
      {toolbar}
      <TabsList className="h-9 gap-0 rounded-lg border border-border bg-background/60 p-1">
        <SourceTab
          value="runtime"
          icon={<Activity />}
          label="Runtime"
          available={runtimeAvailable}
          reason={
            unreachable
              ? "Can't reach the server this app runs on."
              : "This app has no container on its server."
          }
          enabledHint="Live output from the app's container."
        />
        <SourceTab
          value="build"
          icon={<Hammer />}
          label="Build"
          available={buildAvailable}
          reason="This app has never been deployed."
          enabledHint="Output from the latest build."
        />
      </TabsList>
    </>
  );

  return (
    <Tabs
      value={source}
      onValueChange={(v) => setChosen(v as Source)}
      className="flex min-h-0 flex-1 flex-col"
    >
      {/* Radix unmounts the inactive panel, so exactly one of these is ever
          live: one SSE stream, or one 500ms build poll. Never both. */}
      {runtimeAvailable ? (
        <TabsContent
          value="runtime"
          className="mt-0 flex min-h-0 flex-1 flex-col focus-visible:ring-0"
        >
          <ContainerLogs
            appId={appId}
            instances={instances}
            runtime={runtime}
            notice={runtimeNotice(runtime)}
            title={title}
            toolbar={controls}
            supportsTimeline={supportsTimeline}
            logMaxDays={logMaxDays}
          />
        </TabsContent>
      ) : null}

      {buildAvailable ? (
        <TabsContent
          value="build"
          className="mt-0 flex min-h-0 flex-1 flex-col focus-visible:ring-0"
        >
          <BuildLogStream
            // Keyed by id so a redeploy remounts against the new build cleanly
            // (fresh log buffer, its own polling) rather than appending to the old.
            key={depId}
            deploymentId={depId!}
            initialLogs={depId === seededId ? initialBuildLogs : []}
            initialStatus={depStatus!}
            notice={noticeForStatus(depStatus!)}
            title={title}
            toolbar={controls}
            fill
          />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

/** Which log source the pane is showing. */
type Source = "runtime" | "build";

/**
 * One half of the Runtime/Build switch.
 *
 * A source with nothing behind it is DISABLED rather than hidden, and its
 * tooltip says which of the three reasons applies — "no container" and "can't
 * reach the server" look identical from the outside and mean opposite things,
 * one permanent until you deploy and one that clears itself. A disabled Radix
 * trigger takes no pointer events, so the tooltip needs a wrapper that does.
 */
function SourceTab({
  value,
  icon,
  label,
  available,
  reason,
  enabledHint,
}: {
  value: Source;
  icon: React.ReactNode;
  label: string;
  available: boolean;
  reason: string;
  enabledHint: string;
}) {
  return (
    <SimpleTooltip content={available ? enabledHint : reason}>
      <span className="inline-flex">
        <TabsTrigger
          value={value}
          disabled={!available}
          className="px-2.5 py-1 text-xs data-[state=active]:bg-accent"
        >
          {icon}
          {label}
        </TabsTrigger>
      </span>
    </SimpleTooltip>
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
