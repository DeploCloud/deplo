"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Ban, Clock } from "lucide-react";
import { gql, gqlAction } from "@/lib/graphql-client";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/shared/copy-button";
import { DownloadButton } from "@/components/shared/download-button";
import { LogLines, LogRow } from "@/components/shared/log-line-row";
import { cn } from "@/lib/utils";
import { levelLabelPadded } from "@/lib/log-levels";
import type { DeploymentStatus, LogLine } from "@/lib/types";

/** A deployment is finished once it leaves the queued/building states. */
const TERMINAL: ReadonlySet<DeploymentStatus> = new Set<DeploymentStatus>([
  "ready",
  "error",
  "canceled",
]);

const POLL_MS = 500;
/** Treat "within this many px of the bottom" as "at the bottom" → keep following. */
const BOTTOM_THRESHOLD = 24;

/**
 * Format a timestamp as a stable `HH:MM:SS` string.
 *
 * `toLocaleTimeString()` formats in the server's timezone/locale during SSR and
 * the browser's during hydration, so the two never match → hydration error.
 * We pad a fixed UTC `HH:MM:SS` instead: deterministic across server and client,
 * and the right shape for a log terminal regardless of the viewer's locale.
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

export function BuildLogStream({
  deploymentId,
  initialLogs,
  initialStatus,
  initialQueuePosition = null,
  showQueueBanner = false,
}: {
  deploymentId: string;
  initialLogs: LogLine[];
  initialStatus: DeploymentStatus;
  /** Seed for the queued banner's position (detail page only); the poll keeps it
   *  fresh. Omitted where the banner isn't shown. */
  initialQueuePosition?: number | null;
  /** Render the "in queue — position N" banner above the console while the
   *  deployment is `queued` with no logs yet. The deployment-detail view opts in;
   *  the app Logs view already shows its own queued/stopped notice, so it doesn't. */
  showQueueBanner?: boolean;
}) {
  // The log list is NOT seeded from `initialLogs` and is NOT server-rendered.
  // Logs are volatile (a build appends lines, a redeploy rewrites them), so any
  // SSR'd copy is a point-in-time snapshot. Worse, Next's client Router Cache
  // holds this segment for ~30s (the route has a loading.tsx), so a soft reload
  // (Ctrl+R) can paint cached rows and reconcile them against a fresher server
  // render — a guaranteed hydration mismatch the component can't avoid while it
  // SSRs rows. Starting empty means the server emits zero rows; the client fills
  // them from a fetch after mount, so the first client render always matches the
  // server regardless of cache state. `initialLogs` is still accepted (and used
  // as the seed below) so the data already in the RSC payload paints immediately
  // without waiting on the first fetch round-trip — but it lives in state, never
  // in the SSR output, because state is only read after hydration.
  const [logs, setLogs] = React.useState<LogLine[]>([]);
  const [status, setStatus] = React.useState<DeploymentStatus>(initialStatus);
  // Live slot in the owning server's build queue while `queued`; null otherwise.
  // Seeded from the RSC payload so the banner shows a position without waiting on
  // the first poll, then refreshed by the poll below as the builds ahead finish.
  const [queuePosition, setQueuePosition] =
    React.useState<number | null>(initialQueuePosition);
  const [follow, setFollow] = React.useState(true);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  // Set while WE move the scrollbar so the onScroll handler doesn't mistake our
  // own scroll for the user scrolling away and turn off follow.
  const programmaticScroll = React.useRef(false);

  const live = !TERMINAL.has(status);

  const router = useRouter();
  const [stopping, startStop] = React.useTransition();
  // Last status we pushed to the server-rendered parts of the page. The top
  // "Status" badge and "Build time" are RSC-rendered from `getDeployment` and
  // DON'T share this component's polled `status`, so they'd sit stale through a
  // queued→building→ready run until a manual reload. When the poll below sees the
  // status move, refresh the route so those server-rendered cells re-render too.
  const lastSyncedStatus = React.useRef<DeploymentStatus>(initialStatus);

  // Stop the build you're watching. cancelDeployment flips the row to `canceled`;
  // the next log poll (below) picks that up, `live` goes false, and this button
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

  // Seed the log list from the RSC payload, entirely client-side (post-
  // hydration), so the data already in the payload paints without a network
  // round-trip. Keyed on `deploymentId` ONLY — deliberately NOT on `live`: when
  // a build finishes, `live` flips true→false and re-running this would clobber
  // the freshly polled logs back to the (possibly empty) seed for a beat before
  // the fetch below restores them.
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
  // deployment whose initialLogs seed may be stale), then keep polling only
  // while the build is live. Runs after the seed effect on mount, so there's no
  // seed-vs-fetch race.
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

  const logText = React.useMemo(
    () =>
      logs
        .map(
          (l) =>
            `[${formatLogTime(l.ts)}] ${levelLabelPadded(l.level)} ${l.text}`,
        )
        .join("\n"),
    [logs],
  );

  return (
    <div className="space-y-2">
      {showQueueBanner && status === "queued" && logs.length === 0 && (
        <QueuedBanner position={queuePosition} />
      )}
      <div className="overflow-hidden rounded-xl border border-border bg-[#0a0a0a]">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            {logs.length} lines
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
          <div className="flex items-center gap-2">
            {live && (
              <Button
                variant="outline"
                size="sm"
                onClick={stopBuild}
                disabled={stopping}
                className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              >
                <Ban className="size-3.5" />
                {stopping ? "Stopping…" : "Stop build"}
              </Button>
            )}
            <CopyButton value={logText} label="Copy logs" />
            <DownloadButton
              value={logText}
              filename={`build-${deploymentId}.log`}
              label="Download"
            />
          </div>
        </div>
        <LogLines
          ref={scrollRef}
          onScroll={onScroll}
          className="max-h-120 text-xs"
        >
          {logs.map((l, i) => (
            <LogRow
              key={i}
              level={l.level}
              text={l.text}
              time={formatLogTime(l.ts)}
            />
          ))}
        </LogLines>
      </div>
    </div>
  );
}

/**
 * The "waiting in the build queue" banner shown above the console while a
 * deployment is `queued` with no logs yet — it hasn't been claimed off its owning
 * server's queue. `position` is its 1-based slot in that queue (1 = next to
 * build); null when the position can't be resolved, so the banner still explains
 * the wait without inventing a number.
 */
function QueuedBanner({ position }: { position: number | null }) {
  const ahead = position == null ? 0 : position - 1;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-[var(--warning)]/30 bg-[var(--warning)]/10 px-4 py-3">
      <Clock className="mt-0.5 size-4 shrink-0 text-[var(--warning)]" />
      <div className="min-w-0 text-sm">
        <p className="font-medium text-foreground">This deployment is queued</p>
        <p className="text-muted-foreground">
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
