"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
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
import { isDeploymentLive } from "@/lib/deployment-status";
import { stripAnsi } from "@/lib/ansi";
import { levelLabelPadded } from "@/lib/log-levels";
import type { DeploymentStatus, LogLine } from "@/lib/types";

const POLL_MS = 500;
/** Treat "within this many px of the bottom" as "at the bottom" → keep following. */
const BOTTOM_THRESHOLD = 24;

/**
 * Format a timestamp as a stable `HH:MM:SS` string. `toLocaleTimeString()` formats
 * in the server's timezone/locale during SSR and the browser's during hydration,
 * so the two never match → hydration error.
 */
function formatLogTime(ts: string): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

const DEPLOYMENT_LOGS_QUERY = /* GraphQL */ `
  query DeploymentLogs($id: String!) {
    deployment(id: $id) {
      status
      queuePosition
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
    logs: LogLine[];
  } | null;
};

/**
 * One deployment's build output — the WHOLE of where build logs are read.
 */
export function BuildLogStream({
  deploymentId,
  initialLogs,
  initialStatus,
  initialQueuePosition = null,
}: {
  deploymentId: string;
  initialLogs: LogLine[];
  initialStatus: DeploymentStatus;
  /** Seed for the queued banner's position; the poll keeps it fresh. */
  initialQueuePosition?: number | null;
}) {
  // The log list is NOT seeded from `initialLogs` and is NOT server-rendered.
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const [status, setStatus] = React.useState<DeploymentStatus>(initialStatus);
  // Live slot in the owning server's build queue while `queued`; null otherwise.
  // Seeded from the RSC payload so the banner shows a position without waiting on
  // the first poll, then refreshed by the poll below as the builds ahead finish.
  const [queuePosition, setQueuePosition] = React.useState<number | null>(
    initialQueuePosition,
  );
  const [follow, setFollow] = React.useState(true);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  // Set while WE move the scrollbar so the onScroll handler doesn't mistake our
  // own scroll for the user scrolling away and turn off follow.
  const programmaticScroll = React.useRef(false);

  const live = isDeploymentLive(status);

  const router = useRouter();
  const [stopping, startStop] = React.useTransition();
  // Last status we pushed to the server-rendered parts of the page.
  const lastSyncedStatus = React.useRef<DeploymentStatus>(initialStatus);

  // Stop the build you're watching. cancelDeployment flips the row to `canceled`; the
  // next log poll (below) picks that up, `live` goes false, and this button
  // disappears on its own. router.refresh() re-renders the server card's status
  // badge, which doesn't share this component's polled state.
  function stopBuild() {
    startStop(async () => {
      const res = await gqlAction<{ cancelDeployment: boolean }, boolean>(
        `mutation ($id: String!) { cancelDeployment(id: $id) }`,
        { id: deploymentId },
        (d) => d.cancelDeployment,
      );
      if (res.ok) {
        // false ⇒ the build finished in the window before the click landed.
        if (res.data) toast.success("Build stopped");
        else toast.info("This build already finished");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  // Seed the log list from the RSC payload, entirely client-side (post- hydration),
  // so the data already in the payload paints without a network round-trip.
  React.useEffect(() => {
    // Client-only seed: paints the RSC-payload logs post-hydration. Deliberate
    // setState-in-effect — it is what keeps the rows out of the SSR output.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLogs(initialLogs);
    // initialLogs is intentionally omitted: it is the SSR snapshot for this
    // deploymentId and only used to seed; re-seeding on its identity churn would
    // clobber freshly fetched logs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploymentId]);

  // Fetch once to reconcile against the latest server state (covers a terminal
  // deployment whose initialLogs seed may be stale), then keep polling only while the
  // build is live.
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
        // Sync the server-rendered status badge / build time on each transition
        // (queued→building→ready/error/canceled) so they update live, not just on
        // reload. Guarded by a ref so it fires once per change, not every poll.
        if (data.deployment.status !== lastSyncedStatus.current) {
          lastSyncedStatus.current = data.deployment.status;
          router.refresh();
        }
      } catch {
        // Transient fetch/abort error — keep polling; the next tick retries.
      }
    }

    tick();
    const timer = live ? setInterval(tick, POLL_MS) : null;
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearInterval(timer);
    };
  }, [deploymentId, live, router]);

  // Stick to the bottom when new lines arrive, but only while following.
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
    // Scrolling up pauses follow; scrolling back to the bottom resumes it.
    setFollow(atBottom);
  }

  // Search + level filter.
  const filters = useLogFilters(logs, BUILD_LEVELS);

  const logText = React.useMemo(
    () =>
      filters.shown
        .map(
          (l) =>
            `[${formatLogTime(l.ts)}] ${levelLabelPadded(l.level)} ${stripAnsi(l.text)}`,
        )
        .join("\n"),
    [filters.shown],
  );

  return (
    <div className="space-y-2">
      {status === "queued" && logs.length === 0 && (
        <QueuedBanner position={queuePosition} />
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-terminal">
        {/* Every control beside the search input is h-9 — `size="sm"` is h-8,
            which lands a button 4px short of an Input and reads as a broken row. */}
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
            // No max width: the search box takes whatever the row has left, so the toolbar has
            // no dead gap in the middle and a long query stays readable.
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
                className="h-9 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Ban />
                {stopping ? "Stopping" : "Stop build"}
              </Button>
            )}
            {/* h-9 like everything else on this row: the labelled buttons are
                `size="sm"`, which is h-8 and lands them 4px short of the search
                input beside them. */}
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
              time={formatLogTime(l.ts)}
              highlight={filters.highlight}
            />
          ))}

          {/**
           * Claimed but silent: the build is running and hasn't printed a line yet. Gated on
           * `live` — a finished deployment with no logs is done waiting, and a skeleton there
           * would lie.
           */}
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

/**
 * The "waiting in the build queue" banner shown above the console while a
 * deployment is `queued` with no logs yet — it hasn't been claimed off its owning
 * server's queue.
 */
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
              ? "It's next in line — the build starts as soon as a slot frees up on the owning server."
              : ahead === 1
                ? "Position 2 in the build queue — it starts once the build ahead of it finishes on the owning server."
                : `Position ${position} in the build queue — it starts once the ${ahead} builds ahead of it finish on the owning server.`}
        </p>
      </div>
    </div>
  );
}
