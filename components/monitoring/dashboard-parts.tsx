"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { GAP_MS } from "@/lib/monitoring/chart-gaps";
import { cn } from "@/lib/utils";

/**
 * Shared presentational pieces for the monitoring dashboards — the current-value
 * tile, the chart card, the time-window selector and the live/stale status line.
 * Extracted so the per-app / per-database Monitoring tab
 * (container-monitoring-dashboard.tsx) renders identically to the fleet
 * Monitoring page without copying its layout. Pure/dumb: no data fetching.
 */

/**
 * How often a dashboard re-reads the control plane's ring buffer.
 *
 * ITS MEANING CHANGED with the telemetry stream (lib/monitoring/supervisor.ts).
 * It used to be the AGENT MEASUREMENT RATE: each tick was a per-viewer GraphQL
 * call that dialled the owning host and made it measure, so the fleet's cost
 * scaled with how many people had a tab open. Nothing on a host measures because
 * of this timer any more — the agent samples on its own ticker and pushes frames
 * — so this is now purely a BUFFER READ RATE: how quickly a chart notices a
 * frame that already landed in control-plane RAM.
 *
 * Kept at 1s rather than matched to the 5s stream cadence deliberately. It is
 * cheap (an in-RAM read behind one already-authenticated request), it is
 * decoupled from the cadence — which the agent may clamp anywhere in [1s, 60s],
 * so pinning the read rate to an assumed 5s would make a faster host render
 * slower than it reports — and it keeps the freshest frame's latency under a
 * second instead of adding a beat of its own on top of the agent's.
 */
export const POLL_MS = 1000;
/**
 * How stale the newest buffered sample may get before a dashboard stops calling
 * itself live.
 *
 * Deliberately the SAME threshold the charts band "No data" at, so the status
 * line and the chart can never disagree: the moment a gap is wide enough to draw
 * as a band, the header stops claiming the feed is live. See `GAP_MS` for the
 * derivation (stream cadence + the supervisor's reconnect backoff cap, plus
 * headroom) — it moves with the supervisor, and this must not fork from it.
 */
export const STALE_AFTER_MS = GAP_MS;
/**
 * Rolling live buffer cap.
 *
 * Sized for the FASTEST CADENCE THE AGENT WILL SERVE, not the 5s default: the
 * agent clamps `interval_ms` to a 1000ms floor, so a full 16-minute window at 1s
 * is ~960 points. Mirrors `HARD_CAP` in lib/monitoring/history.ts for exactly
 * that reason. Trimming this toward the ~200 the default cadence needs would
 * look like a saving and act as silent truncation — the widest preset would stop
 * being able to fill the moment anyone lowered the cadence, with nothing
 * anywhere to say why.
 */
export const MAX_POINTS = 1200;

/** Lookback presets for the charts' fixed sliding window. */
export const WINDOWS = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
] as const;

/** A current-value tile with a small saturation bar (turns amber over 80%). */
export function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  pct,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  sub: string;
  /** 0-100 saturation for the bar; omit for a value with no natural ceiling. */
  pct?: number;
}) {
  const over = (pct ?? 0) > 80;
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="size-4" />
          <span className="text-xs">{label}</span>
        </div>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        {pct !== undefined && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                over ? "bg-[var(--warning)]" : "bg-foreground/80",
              )}
              style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
            />
          </div>
        )}
        <p className="text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

/** A titled card wrapping a chart, with an optional live current-value caption. */
export function ChartCard({
  title,
  caption,
  className,
  children,
}: {
  title: string;
  caption?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Card className={className}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">{title}</CardTitle>
        {caption && (
          <p className="text-xs text-muted-foreground tabular-nums">{caption}</p>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/** A small labelled read-out for the info strip. */
export function InfoItem({
  icon: Icon,
  label,
  value,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </div>
      <p className="truncate font-mono text-sm tabular-nums">{value}</p>
    </div>
  );
}

/** The 1m / 5m / 15m chart-window selector. */
export function WindowSelector({
  windowMs,
  onChange,
}: {
  windowMs: number;
  onChange: (ms: number) => void;
}) {
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border p-0.5"
      role="group"
      aria-label="Chart time window"
    >
      {WINDOWS.map((w) => (
        <button
          key={w.label}
          type="button"
          onClick={() => onChange(w.ms)}
          aria-pressed={windowMs === w.ms}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs transition-colors",
            windowMs === w.ms
              ? "bg-secondary font-medium"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          Last {w.label}
        </button>
      ))}
    </div>
  );
}

/** "Live · streaming", or an amber "not answering — showing data up to …". */
export function LiveStatusLine({
  stale,
  asOf,
}: {
  /** True when the buffer has stopped advancing (see `STALE_AFTER_MS`). */
  stale: boolean;
  /** ts (epoch ms) of the newest real sample, for the stale message. */
  asOf: number;
}) {
  if (stale) {
    return (
      <div className="flex items-center gap-2 text-xs text-[var(--warning)]">
        <span className="inline-flex size-2 rounded-full bg-[var(--warning)]" />
        Not answering — showing data up to {fmtClock(asOf)}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="relative flex size-2">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--success)] opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-[var(--success)]" />
      </span>
      {/* NOT "sampling every Ns": the cadence is the agent's to choose (it
          clamps our hint into [1s, 60s]) and this timer no longer causes a
          measurement at all — it only re-reads a buffer the agent is pushing
          into. Naming a number here would be stating a rate the UI does not
          know and does not control. */}
      Live · streaming
    </div>
  );
}

/** Wall-clock HH:MM:SS for "showing data up to …". */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
