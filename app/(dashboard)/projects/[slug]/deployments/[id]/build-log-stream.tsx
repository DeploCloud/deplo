"use client";

import * as React from "react";
import { gql } from "@/lib/graphql-client";
import { CopyButton } from "@/components/shared/copy-button";
import { cn } from "@/lib/utils";
import type { DeploymentStatus, LogLine } from "@/lib/types";

const LEVEL_CLASS: Record<string, string> = {
  command: "text-zinc-100 font-medium",
  info: "text-zinc-400",
  warn: "text-[var(--warning)]",
  error: "text-destructive",
  debug: "text-muted-foreground",
};

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
    logs: LogLine[];
  } | null;
};

export function BuildLogStream({
  deploymentId,
  initialLogs,
  initialStatus,
}: {
  deploymentId: string;
  initialLogs: LogLine[];
  initialStatus: DeploymentStatus;
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
  const [follow, setFollow] = React.useState(true);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  // Set while WE move the scrollbar so the onScroll handler doesn't mistake our
  // own scroll for the user scrolling away and turn off follow.
  const programmaticScroll = React.useRef(false);

  const live = !TERMINAL.has(status);

  // Seed + refresh the log list, entirely client-side (post-hydration):
  //  1. Paint `initialLogs` immediately so the data already in the RSC payload
  //     shows without a network round-trip.
  //  2. Fetch once to reconcile against the latest server state (covers a
  //     terminal deployment whose initialLogs seed may be stale).
  //  3. Keep polling only while the build is live.
  // Seeding synchronously before the async fetch means no seed-vs-fetch race.
  React.useEffect(() => {
    // Client-only seed: paints the RSC-payload logs post-hydration. Deliberate
    // setState-in-effect — it is what keeps the rows out of the SSR output.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLogs(initialLogs);

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
    // initialLogs is intentionally omitted: it is the SSR snapshot for this
    // deploymentId and only used to seed; re-seeding on its identity churn would
    // clobber freshly fetched logs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploymentId, live]);

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
        .map((l) => `[${formatLogTime(l.ts)}] ${l.text}`)
        .join("\n"),
    [logs],
  );

  return (
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
        <CopyButton value={logText} label="Copy logs" />
      </div>
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="max-h-120 overflow-y-auto p-4 font-mono text-xs leading-relaxed"
      >
        {logs.map((l, i) => (
          <div key={i} className="flex gap-3">
            <span className="shrink-0 select-none text-zinc-600">
              {formatLogTime(l.ts)}
            </span>
            <span className={cn(LEVEL_CLASS[l.level] ?? "text-zinc-300")}>
              {l.text}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
