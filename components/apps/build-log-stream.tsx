"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Ban, Clock, FileSearch } from "lucide-react";
import { gql, gqlAction } from "@/lib/graphql-client";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/shared/copy-button";
import { DownloadButton } from "@/components/shared/download-button";
import {
  LogLines,
  LogLinesSkeleton,
  LogRow,
} from "@/components/shared/log-line-row";
import {
  LogSearch,
  LogLevelFilter,
  useLogFilters,
  BUILD_LEVELS,
} from "@/components/logs/log-filters";
import { BuildPhaseBar } from "@/components/apps/build-phase-bar";
import { isDeploymentLive } from "@/lib/deployment-status";
import { stripAnsi } from "@/lib/ansi";
import { levelLabelPadded } from "@/lib/log-levels";
import { formatClockTime } from "@/lib/utils";
import type { DeploymentStatus, LogLine } from "@/lib/types/deployment";

const POLL_MS = 500;
const BOTTOM_THRESHOLD = 24;

const DEPLOYMENT_LOGS_QUERY = /* GraphQL */ `
  query DeploymentLogs($id: String!) {
    deployment(id: $id) {
      status
      queuePosition
      startedAt
      buildDurationMs
      logs {
        ts
        level
        text
      }
    }
  }
`;

type LogsResponse = {
  deployment: {
    status: DeploymentStatus;
    queuePosition: number | null;
    startedAt: string | null;
    buildDurationMs: number | null;
    logs: LogLine[];
  } | null;
};

export function BuildLogStream({
  deploymentId,
  initialLogs,
  initialStatus,
  initialQueuePosition = null,
  initialStartedAt = null,
  initialBuildDurationMs = null,
}: {
  deploymentId: string;
  initialLogs: LogLine[];
  initialStatus: DeploymentStatus;
  initialQueuePosition?: number | null;
  initialStartedAt?: string | null;
  initialBuildDurationMs?: number | null;
}) {
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const [status, setStatus] = React.useState<DeploymentStatus>(initialStatus);
  const [queuePosition, setQueuePosition] = React.useState<number | null>(
    initialQueuePosition,
  );
  const [startedAt, setStartedAt] = React.useState(initialStartedAt);
  const [buildDurationMs, setBuildDurationMs] = React.useState(
    initialBuildDurationMs,
  );
  const [follow, setFollow] = React.useState(true);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const programmaticScroll = React.useRef(false);

  const live = isDeploymentLive(status);

  const router = useRouter();
  const [stopping, startStop] = React.useTransition();
  const lastSyncedStatus = React.useRef<DeploymentStatus>(initialStatus);

  function stopBuild() {
    startStop(async () => {
      const res = await gqlAction<{ cancelDeployment: boolean }, boolean>(
        `mutation ($id: String!) { cancelDeployment(id: $id) }`,
        { id: deploymentId },
        (d) => d.cancelDeployment,
      );
      if (res.ok) {
        if (res.data) toast.success("Build stopped");
        else toast.info("This build already finished");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLogs(initialLogs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploymentId]);

  React.useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function tick() {
      try {
        const data = await gql<LogsResponse>(
          DEPLOYMENT_LOGS_QUERY,
          { id: deploymentId },
          controller.signal,
        );
        if (cancelled || !data.deployment) return;
        setLogs(data.deployment.logs);
        setStatus(data.deployment.status);
        setQueuePosition(data.deployment.queuePosition ?? null);
        setStartedAt(data.deployment.startedAt ?? null);
        setBuildDurationMs(data.deployment.buildDurationMs ?? null);
        if (data.deployment.status !== lastSyncedStatus.current) {
          lastSyncedStatus.current = data.deployment.status;
          router.refresh();
        }
      } catch {}
    }

    tick();
    const timer = live ? setInterval(tick, POLL_MS) : null;
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [deploymentId, live, router]);

  React.useEffect(() => {
    if (!follow) return;
    const el = scrollRef.current;
    if (!el) return;
    programmaticScroll.current = true;
    el.scrollTop = el.scrollHeight;
  }, [logs, follow]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    if (programmaticScroll.current) {
      programmaticScroll.current = false;
      return;
    }
    const atBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD;
    setFollow(atBottom);
  }

  const filters = useLogFilters(logs, BUILD_LEVELS);

  const logText = React.useMemo(
    () =>
      filters.shown
        .map(
          (l) =>
            `[${formatClockTime(l.ts)}] ${levelLabelPadded(l.level)} ${stripAnsi(l.text)}`,
        )
        .join("\n"),
    [filters.shown],
  );

  return (
    <div className="space-y-2">
      {status === "queued" && logs.length === 0 && (
        <QueuedBanner position={queuePosition} />
      )}
      <BuildPhaseBar
        logs={logs}
        status={status}
        startedAt={startedAt}
        buildDurationMs={buildDurationMs}
      />
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-terminal">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
            {logs.length === 1 ? "1 line" : `${logs.length} lines`}
            {live && (
              <span className="flex items-center gap-1.5 text-[var(--warning)]">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--warning)] opacity-60" />
                  <span className="relative inline-flex size-2 rounded-full bg-[var(--warning)]" />
                </span>
                Live
              </span>
            )}
          </span>

          <LogSearch
            value={filters.state.q}
            onChange={(q) => filters.setState((s) => ({ ...s, q }))}
            className="basis-full sm:basis-auto"
          />
          <LogLevelFilter
            facet={filters.facet}
            values={filters.state.levels}
            counts={filters.counts}
            onChange={(levels) => filters.setState((s) => ({ ...s, levels }))}
          />

          <div className="ml-auto flex shrink-0 items-center gap-2">
            {live && (
              <Button
                variant="outline"
                size="sm"
                onClick={stopBuild}
                disabled={stopping}
                className="h-9 border-destructive/40 text-destructive hover:bg-destructive-wash-strong hover:text-destructive"
              >
                <Ban />
                {stopping ? "Stopping" : "Stop build"}
              </Button>
            )}
            <CopyButton value={logText} label="Copy logs" className="h-9" />
            <DownloadButton
              value={logText}
              filename={`build-${deploymentId}.log`}
              label="Download"
              className="h-9"
            />
          </div>
        </div>
        <LogLines
          ref={scrollRef}
          onScroll={onScroll}
          className="max-h-120 text-xs"
        >
          {filters.shown.map((l, i) => (
            <LogRow
              key={i}
              level={l.level}
              text={l.text}
              time={formatClockTime(l.ts)}
              highlight={filters.highlight}
            />
          ))}

          {logs.length === 0 && live ? <LogLinesSkeleton /> : null}

          {logs.length > 0 && filters.shown.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
              <FileSearch className="size-5 text-zinc-500" />
              <p className="text-[11px] text-zinc-500">
                No log lines match your filters.
              </p>
            </div>
          ) : null}
        </LogLines>
      </div>
    </div>
  );
}

function QueuedBanner({ position }: { position: number | null }) {
  const ahead = position == null ? 0 : position - 1;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-4 py-3">
      <Clock className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-foreground">This deployment is queued</p>
        <p className="mt-1 text-muted-foreground">
          {position == null
            ? "Waiting for a free build slot on the owning server."
            : ahead === 0
              ? "It's next in line - the build starts as soon as a slot frees up on the owning server."
              : ahead === 1
                ? "Position 2 in the build queue - it starts once the build ahead of it finishes on the owning server."
                : `Position ${position} in the build queue - it starts once the ${ahead} builds ahead of it finish on the owning server.`}
        </p>
      </div>
    </div>
  );
}
