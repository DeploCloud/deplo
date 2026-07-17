"use client";

import * as React from "react";
import { cn, formatBytes } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Public contract                                                     */
/* ------------------------------------------------------------------ */

export interface ChartSeriesDef {
  /** Key into each point's `values` record. */
  key: string;
  /** Legend / tooltip label. */
  label: string;
  /** CSS color for the line (a `--chart-*` token). Marks only — never text. */
  color: string;
  /** Render a soft ~10% wash under the line (single-series charts). */
  fill?: boolean;
}

export interface ChartPoint {
  /** Sample timestamp (ms epoch) — the x position. */
  ts: number;
  values: Record<string, number>;
}

/** The unit drives the y domain, tick generation and value formatting. */
export type ChartUnit = "percent" | "bytesPerSec" | "count";

/* ------------------------------------------------------------------ */
/* Scales & formatting                                                 */
/* ------------------------------------------------------------------ */

/**
 * Two consecutive samples further apart than this are NOT connected — the poll
 * skipped (agent offline, tab throttled), and drawing through the hole would
 * fabricate data. The gap renders as a break in the line, like Grafana's
 * "connect null values: never".
 */
const GAP_MS = 10_000;

const M_TOP = 10;
const M_RIGHT = 12;
const M_BOTTOM = 24;

/** Zoom bounds (the visible span). Floor keeps a zoom-in from collapsing past a
 *  handful of samples; ceiling is a backstop — the buffered span caps it first. */
const MIN_WINDOW_MS = 10_000;
const MAX_WINDOW_MS = 30 * 60_000;
/** One wheel notch / `+` press narrows the window to this fraction (Grafana-ish);
 *  its reciprocal widens it. */
const ZOOM_IN = 0.8;

/** Snap a rough step to the 1/2/5 ladder so tick values read as clean numbers. */
function niceStep(rough: number): number {
  const pow = 10 ** Math.floor(Math.log10(rough));
  const frac = rough / pow;
  if (frac <= 1) return pow;
  if (frac <= 2) return 2 * pow;
  if (frac <= 5) return 5 * pow;
  return 10 * pow;
}

/** Clean ticks 0..niceMax covering `max` (~`target` intervals). */
function linearTicks(max: number, target: number): number[] {
  const step = niceStep(max / target);
  const n = Math.max(1, Math.ceil(max / step - 1e-9));
  // Multiply instead of accumulating so float dust never reaches the labels.
  return Array.from({ length: n + 1 }, (_, i) => Number((i * step).toFixed(10)));
}

function yTicksFor(unit: ChartUnit, dataMax: number): number[] {
  // Percent axes are pinned to 0–100: utilization only reads honestly against
  // its full range (a 3% wiggle must not fill the panel).
  if (unit === "percent") return [0, 25, 50, 75, 100];
  // Idle network still gets a real axis (1 kB/s) instead of a degenerate 0–0.
  if (unit === "bytesPerSec") return linearTicks(Math.max(dataMax, 1000), 4);
  return linearTicks(Math.max(dataMax, 1), 4);
}

/** Axis-tick formatting: clean numbers with their unit on every tick. */
function fmtAxis(v: number, unit: ChartUnit): string {
  if (unit === "percent") return `${Math.round(v)}%`;
  if (unit === "bytesPerSec") return v === 0 ? "0" : `${formatBytes(v)}/s`;
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(2)));
}

/** Tooltip/legend formatting: the precise reading. */
function fmtValue(v: number, unit: ChartUnit): string {
  if (unit === "percent") return `${v.toFixed(1)}%`;
  if (unit === "bytesPerSec") return `${formatBytes(v)}/s`;
  return v.toFixed(2);
}

/** Time-tick ladder (seconds) — steps that land on clean wall-clock times. */
const TIME_STEPS_S = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];

function timeTicks(
  t0: number,
  t1: number,
  maxCount: number,
): { ticks: number[]; stepMs: number } {
  const span = t1 - t0;
  const stepMs =
    (TIME_STEPS_S.find((s) => span / (s * 1000) <= maxCount) ?? 3600) * 1000;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / stepMs) * stepMs; t <= t1; t += stepMs) ticks.push(t);
  return { ticks, stepMs };
}

function fmtTime(ts: number, withSeconds: boolean): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  const base = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSeconds ? `${base}:${p(d.getSeconds())}` : base;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/* ------------------------------------------------------------------ */
/* Geometry                                                            */
/* ------------------------------------------------------------------ */

interface XY {
  x: number;
  y: number;
}

/** Split a series into gap-free runs of screen coordinates. */
function segmentsFor(
  pts: ChartPoint[],
  key: string,
  xOf: (ts: number) => number,
  yOf: (v: number) => number,
): XY[][] {
  const segs: XY[][] = [];
  let cur: XY[] = [];
  let prevTs: number | null = null;
  for (const p of pts) {
    const v = p.values[key];
    if (v == null || !Number.isFinite(v)) {
      if (cur.length) segs.push(cur);
      cur = [];
      prevTs = null;
      continue;
    }
    if (prevTs !== null && p.ts - prevTs > GAP_MS && cur.length) {
      segs.push(cur);
      cur = [];
    }
    cur.push({ x: xOf(p.ts), y: yOf(v) });
    prevTs = p.ts;
  }
  if (cur.length) segs.push(cur);
  return segs;
}

function linePath(seg: XY[]): string {
  return seg
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join("");
}

function areaPath(seg: XY[], baseY: number): string {
  const first = seg[0];
  const last = seg[seg.length - 1];
  return (
    `M${first.x.toFixed(2)},${baseY.toFixed(2)}` +
    seg.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join("") +
    `L${last.x.toFixed(2)},${baseY.toFixed(2)}Z`
  );
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

/**
 * Grafana-style live time-series panel: documented axes (unit-formatted y
 * ticks, wall-clock x ticks), recessive hairline grid, gap-aware 2px lines,
 * a crosshair + all-series tooltip (pointer AND arrow keys), and — for two
 * or more series — a legend with live values that toggles series on/off.
 *
 * The x domain is a sliding window `windowMs` wide. By default it ends at the
 * newest sample — "Last 5m" always means exactly that, and a freshly-opened page
 * fills leftward as samples accumulate. Pass `domainEnd` to pin the window's END
 * to an absolute time instead (Grafana-style: scrolling to zoom FREEZES the range
 * so the region under the cursor doesn't slide away as new samples stream in).
 *
 * Zoom is driven from here — the panel owns the cursor position and the x scale —
 * but reported UP via `onZoomChange` so a dashboard can keep every chart on one
 * shared range. Wheel (anchored under the pointer), `+`/`-` (around centre) and
 * double-click / `0` (back to live) are the gestures.
 */
export function TimeSeriesChart({
  series,
  points,
  windowMs,
  unit,
  height = 200,
  ariaLabel,
  domainEnd,
  onZoomChange,
  onResetLive,
}: {
  series: ChartSeriesDef[];
  points: ChartPoint[];
  windowMs: number;
  unit: ChartUnit;
  height?: number;
  ariaLabel: string;
  /** Absolute end of the window (ms epoch) to FREEZE it; null/undefined = live
   *  (pinned to the newest sample). */
  domainEnd?: number | null;
  /** Report a new frozen window after a zoom gesture (span + absolute end). */
  onZoomChange?: (next: { windowMs: number; domainEnd: number }) => void;
  /** Return to live (double-click or `0`). */
  onResetLive?: () => void;
}) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [width, setWidth] = React.useState(0);
  const [hoverTs, setHoverTs] = React.useState<number | null>(null);
  const [hidden, setHidden] = React.useState<Set<string>>(() => new Set());
  const clipId = `tschart-clip-${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      setWidth(entries[0].contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visibleSeries = series.filter((s) => !hidden.has(s.key));
  const last = points.length ? points[points.length - 1] : null;
  const hasData = points.length >= 2;

  // Sliding window: ends at `domainEnd` when frozen by a zoom, else at the newest
  // sample (live). `newest` stays the live edge either way — the zoom clamps to it.
  const newest = last?.ts ?? 0;
  const t1 = domainEnd ?? newest;
  const t0 = t1 - windowMs;

  // Points inside the window, plus one earlier sample so the line enters from
  // the left edge instead of starting mid-plot (the clip rect crops it).
  const firstIdx = points.findIndex((p) => p.ts >= t0);
  const drawPoints = firstIdx >= 0 ? points.slice(Math.max(0, firstIdx - 1)) : [];
  const hoverPoints = firstIdx >= 0 ? points.slice(firstIdx) : [];

  let dataMax = 0;
  for (const p of drawPoints) {
    for (const s of visibleSeries) {
      const v = p.values[s.key];
      if (v != null && Number.isFinite(v) && v > dataMax) dataMax = v;
    }
  }

  const yTicks = yTicksFor(unit, dataMax);
  const yMax = yTicks[yTicks.length - 1];
  const yLabels = yTicks.map((t) => fmtAxis(t, unit));
  // Left gutter sized to the widest tick label (10px font ≈ 6.2px/char).
  const mLeft = Math.max(
    34,
    Math.round(Math.max(...yLabels.map((l) => l.length)) * 6.2 + 14),
  );

  const plotW = Math.max(0, width - mLeft - M_RIGHT);
  const plotH = Math.max(0, height - M_TOP - M_BOTTOM);

  const xOf = (ts: number) => mLeft + ((ts - t0) / windowMs) * plotW;
  const yOf = (v: number) => M_TOP + plotH * (1 - clamp(v / yMax, 0, 1));

  const xt = timeTicks(t0, t1, Math.max(3, Math.floor(plotW / 90)));

  // Snap the stored hover time to the nearest visible sample — storing a time
  // (not an index) keeps the crosshair still while new samples stream in.
  let hoverPoint: ChartPoint | null = null;
  if (hoverTs != null && hoverPoints.length) {
    hoverPoint = hoverPoints[0];
    for (const p of hoverPoints) {
      if (Math.abs(p.ts - hoverTs) < Math.abs(hoverPoint.ts - hoverTs)) hoverPoint = p;
    }
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = clamp((e.clientX - rect.left - mLeft) / (plotW || 1), 0, 1);
    setHoverTs(t0 + frac * windowMs);
  }

  /**
   * Rescale the window by `scale` (＜1 zooms in) while keeping the timestamp at
   * plot-fraction `frac` pinned under the anchor. Clamps the span to the buffered
   * range and never scrolls past the newest/oldest sample, so zoom-out settles on
   * the whole buffer rather than trailing off into empty space. Freezes the range
   * (reports an absolute `domainEnd`) — the dashboard flips out of live.
   */
  function applyZoom(frac: number, scale: number) {
    if (!onZoomChange || !hasData || plotW <= 0) return;
    const anchorTs = t0 + frac * windowMs;
    const oldest = drawPoints[0]?.ts ?? newest - windowMs;
    const spanCap = Math.max(MIN_WINDOW_MS, newest - oldest);
    const nextWin = clamp(
      windowMs * scale,
      MIN_WINDOW_MS,
      Math.min(MAX_WINDOW_MS, spanCap),
    );
    let end = anchorTs + (1 - frac) * nextWin;
    end = Math.min(end, newest); // never reveal a void to the right of "now"
    const minEnd = oldest + nextWin;
    if (minEnd <= newest) end = Math.max(end, minEnd); // …nor to the left of oldest
    onZoomChange({ windowMs: nextWin, domainEnd: end });
  }

  // Wheel-to-zoom must call preventDefault to stop the page scrolling, but React
  // registers `onWheel` as a passive root listener where that is a no-op — so bind
  // a native non-passive listener, routed through a ref that always holds the
  // latest closure (fresh scale + geometry each render). The ref is refreshed in
  // an effect, never during render.
  const wheelRef = React.useRef<(e: WheelEvent) => void>(() => {});
  React.useEffect(() => {
    wheelRef.current = (e: WheelEvent) => {
      if (!onZoomChange || !hasData || plotW <= 0 || !wrapRef.current) return;
      e.preventDefault();
      const rect = wrapRef.current.getBoundingClientRect();
      const frac = clamp((e.clientX - rect.left - mLeft) / plotW, 0, 1);
      applyZoom(frac, e.deltaY < 0 ? ZOOM_IN : 1 / ZOOM_IN);
    };
  });
  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, []);

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Keyboard parity for the mouse gestures: zoom around the centre, reset to live.
    if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      applyZoom(0.5, ZOOM_IN);
      return;
    }
    if (e.key === "-" || e.key === "_") {
      e.preventDefault();
      applyZoom(0.5, 1 / ZOOM_IN);
      return;
    }
    if (e.key === "0") {
      e.preventDefault();
      onResetLive?.();
      return;
    }
    if (!hoverPoints.length) return;
    const idx = hoverPoint ? hoverPoints.indexOf(hoverPoint) : hoverPoints.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.max(0, idx - 1);
    else if (e.key === "ArrowRight") next = Math.min(hoverPoints.length - 1, idx + 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = hoverPoints.length - 1;
    else if (e.key === "Escape") {
      setHoverTs(null);
      return;
    } else return;
    e.preventDefault();
    setHoverTs(hoverPoints[next].ts);
  }

  function toggleSeries(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else {
        next.add(key);
        // Never hide the last visible series — an all-empty plot helps nobody.
        if (next.size >= series.length) return prev;
      }
      return next;
    });
  }

  const tooltipFlips = hoverPoint ? xOf(hoverPoint.ts) > mLeft + plotW * 0.55 : false;

  return (
    <div
      ref={wrapRef}
      className="relative outline-none"
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      onDoubleClick={() => onResetLive?.()}
      onBlur={() => setHoverTs(null)}
    >
      {width > 0 && hasData ? (
        <svg
          width={width}
          height={height}
          className="block"
          role="img"
          aria-label={ariaLabel}
          onPointerMove={onPointerMove}
          onPointerLeave={() => setHoverTs(null)}
        >
          {/* Horizontal grid + unit-formatted y ticks */}
          {yTicks.map((t, i) => {
            const y = yOf(t);
            return (
              <g key={t}>
                <line
                  x1={mLeft}
                  x2={mLeft + plotW}
                  y1={y}
                  y2={y}
                  className="stroke-border"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={mLeft - 8}
                  y={y}
                  dy="0.32em"
                  textAnchor="end"
                  className="fill-muted-foreground text-[10px] tabular-nums"
                >
                  {yLabels[i]}
                </text>
              </g>
            );
          })}

          {/* Vertical grid + wall-clock x ticks */}
          {xt.ticks.map((t) => {
            const x = xOf(t);
            return (
              <g key={t}>
                <line
                  x1={x}
                  x2={x}
                  y1={M_TOP}
                  y2={M_TOP + plotH}
                  className="stroke-border/60"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                />
                <text
                  x={clamp(x, mLeft + 14, width - 26)}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[10px] tabular-nums"
                >
                  {fmtTime(t, xt.stepMs < 60_000)}
                </text>
              </g>
            );
          })}

          <clipPath id={clipId}>
            <rect x={mLeft} y={M_TOP} width={plotW} height={plotH} />
          </clipPath>

          {/* Series marks: ~10% area wash, 2px gap-aware lines, isolated dots */}
          <g clipPath={`url(#${clipId})`}>
            {visibleSeries.map((s) => {
              const segs = segmentsFor(drawPoints, s.key, xOf, yOf);
              return (
                <g key={s.key}>
                  {s.fill &&
                    segs
                      .filter((seg) => seg.length > 1)
                      .map((seg, i) => (
                        <path
                          key={`a${i}`}
                          d={areaPath(seg, M_TOP + plotH)}
                          fill={s.color}
                          fillOpacity={0.1}
                        />
                      ))}
                  {segs.map((seg, i) =>
                    seg.length > 1 ? (
                      <path
                        key={`l${i}`}
                        d={linePath(seg)}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    ) : (
                      // An isolated sample (gaps on both sides) still shows.
                      <circle
                        key={`p${i}`}
                        cx={seg[0].x}
                        cy={seg[0].y}
                        r={2.5}
                        fill={s.color}
                      />
                    ),
                  )}
                </g>
              );
            })}
          </g>

          {/* Live edge: latest value of each series, ringed in the surface.
              Hidden when a zoom has frozen the window past the newest sample. */}
          {last &&
            last.ts >= t0 &&
            last.ts <= t1 &&
            visibleSeries.map((s) => {
              const v = last.values[s.key];
              if (v == null || !Number.isFinite(v)) return null;
              return (
                <circle
                  key={s.key}
                  cx={xOf(last.ts)}
                  cy={yOf(v)}
                  r={4}
                  fill={s.color}
                  stroke="var(--card)"
                  strokeWidth={2}
                />
              );
            })}

          {/* Crosshair snapped to the hovered sample, with per-series dots */}
          {hoverPoint && (
            <g>
              <line
                x1={xOf(hoverPoint.ts)}
                x2={xOf(hoverPoint.ts)}
                y1={M_TOP}
                y2={M_TOP + plotH}
                className="stroke-foreground/30"
                strokeWidth={1}
              />
              {visibleSeries.map((s) => {
                const v = hoverPoint.values[s.key];
                if (v == null || !Number.isFinite(v)) return null;
                return (
                  <circle
                    key={s.key}
                    cx={xOf(hoverPoint.ts)}
                    cy={yOf(v)}
                    r={4}
                    fill={s.color}
                    stroke="var(--card)"
                    strokeWidth={2}
                  />
                );
              })}
            </g>
          )}
        </svg>
      ) : (
        <div
          style={{ height }}
          className="flex items-center justify-center rounded-lg bg-secondary/40 text-xs text-muted-foreground"
        >
          Collecting metrics…
        </div>
      )}

      {/* Tooltip: timestamp header, then every visible series at that X */}
      {hoverPoint && width > 0 && (
        <div
          className="pointer-events-none absolute z-10 min-w-36 rounded-md border bg-popover px-2.5 py-2 text-xs shadow-md"
          style={{
            left: xOf(hoverPoint.ts),
            top: M_TOP,
            transform: tooltipFlips
              ? "translateX(calc(-100% - 10px))"
              : "translateX(10px)",
          }}
        >
          <p className="mb-1 text-muted-foreground tabular-nums">
            {fmtTime(hoverPoint.ts, true)}
          </p>
          <div className="space-y-0.5">
            {visibleSeries.map((s) => {
              const v = hoverPoint.values[s.key];
              return (
                <div key={s.key} className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                    <span
                      className="h-0.5 w-3 shrink-0 rounded-full"
                      style={{ background: s.color }}
                    />
                    {s.label}
                  </span>
                  <span className="whitespace-nowrap font-medium tabular-nums text-popover-foreground">
                    {v != null && Number.isFinite(v) ? fmtValue(v, unit) : "—"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Legend with live values — only for 2+ series; click toggles a series */}
      {series.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-2">
          {series.map((s) => {
            const isHidden = hidden.has(s.key);
            const v = last?.values[s.key];
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => toggleSeries(s.key)}
                aria-pressed={!isHidden}
                title={isHidden ? `Show ${s.label}` : `Hide ${s.label}`}
                className={cn(
                  "flex items-center gap-1.5 text-xs transition-opacity",
                  isHidden && "opacity-40",
                )}
              >
                <span
                  className="h-0.5 w-3 rounded-full"
                  style={{ background: s.color }}
                />
                <span className="text-muted-foreground">{s.label}</span>
                {v != null && Number.isFinite(v) && (
                  <span className="font-medium tabular-nums">{fmtValue(v, unit)}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
