"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Shared presentational pieces for the monitoring dashboards — the current-value
 * tile, the chart card, the time-window selector and the live/stale status line.
 * Extracted so the per-app / per-database Monitoring tab
 * (container-monitoring-dashboard.tsx) renders identically to the fleet
 * Monitoring page without copying its layout. Pure/dumb: no data fetching.
 */

/** Live poll cadence (ms) shared by every dashboard. */
export const POLL_MS = 1000;
/**
 * How often a dashboard re-merges the control plane's server-side ring buffer
 * into its local point list.
 *
 * The live poll is append-only: a failed request or an offline answer is simply
 * skipped, so without a repair pass every such miss becomes a PERMANENT hole
 * that later renders as a "No data" band — the more window you show, the more of
 * them you see. The background collector (5s) keeps the server buffer dense, so
 * re-seeding on a cadence comfortably inside `GAP_MS` (15s) closes a hole before
 * the chart can ever band it. Cheap: one small query against an in-RAM buffer,
 * no agent RPC.
 */
export const RESEED_MS = 10_000;
/**
 * Rolling live buffer cap. Must hold the largest window (15m) at the DENSEST
 * cadence the buffer can carry, or the widest preset structurally cannot fill:
 * the list merges two sample trains — a viewer's ~1-2s poll and the collector's
 * 5s samples — so 15m needs well over the 900 that a flat 1s assumption gave.
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

/** "Live · sampling every 1s", or an amber "not answering — showing data up to …". */
export function LiveStatusLine({
  stale,
  asOf,
}: {
  /** True when the last poll didn't return a live measurement. */
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
      Live · sampling every {POLL_MS / 1000}s
    </div>
  );
}

/** Wall-clock HH:MM:SS for "showing data up to …". */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
