"use client";

import * as React from "react";
import {
  Cpu,
  MemoryStick,
  HardDrive,
  Network,
  Clock,
  Boxes,
  Gauge,
  ServerOff,
  ArrowDown,
  ArrowUp,
  RadioTower,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/shared/status-badge";
import { TimeSeriesChart } from "@/components/monitoring/time-series-chart";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerMetrics } from "@/lib/data/monitoring";
import type { ServerStatus } from "@/lib/types";
import { cn, formatBytes, serverLabel } from "@/lib/utils";

interface ServerLite {
  id: string;
  name: string;
  status: ServerStatus;
  ip: string;
  dockerVersion: string;
}

/** Rolling live buffer per server — covers the largest window (~15m at 1s). */
const MAX_POINTS = 900;
const POLL_MS = 1000;

/** Lookback presets for the charts' fixed sliding window. */
const WINDOWS = [
  { label: "1m", ms: 60_000 },
  { label: "5m", ms: 300_000 },
  { label: "15m", ms: 900_000 },
] as const;

/**
 * The charts' shared x-axis view. `live` follows the newest sample (the window
 * slides); scrolling to zoom on any chart FREEZES it to an absolute `end` so the
 * inspected span stops sliding away as fresh samples stream in. One view drives
 * every panel, so they stay aligned — zoom one, zoom all.
 */
type TimeView =
  | { mode: "live"; windowMs: number }
  | { mode: "fixed"; windowMs: number; end: number };

/** Human span for the frozen-view label, e.g. 90_000 → "1m 30s". */
function fmtSpan(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

export function MonitoringDashboard({
  servers,
  initialMetrics,
  initialSaveMetrics,
  canManageInfra,
}: {
  servers: ServerLite[];
  initialMetrics: ServerMetrics[];
  /** The stored "save metrics on server" switch state (instance-wide). */
  initialSaveMetrics: boolean;
  /** Cosmetic gate for the switch; the mutation enforces `manage_infra` itself. */
  canManageInfra: boolean;
}) {
  const [selectedId, setSelectedId] = React.useState(servers[0]?.id ?? "");
  const [view, setView] = React.useState<TimeView>({
    mode: "live",
    windowMs: WINDOWS[0].ms,
  });
  const [saveMetrics, setSaveMetrics] = React.useState(initialSaveMetrics);
  const [savingToggle, setSavingToggle] = React.useState(false);
  // Chart history holds live MEASUREMENTS only. The SSR hint (stored status,
  // zeroed net/load) and offline snapshots are placeholders, not measurements —
  // charting them would draw fake dips to 0. The latest poll result (whatever
  // its online flag) lives in `live` so the status line can say "agent not
  // answering" while the charts keep the honest gap.
  const [live, setLive] = React.useState<Record<string, ServerMetrics | undefined>>({});
  const [history, setHistory] = React.useState<Record<string, ServerMetrics[]>>({});

  const selected = servers.find((s) => s.id === selectedId) ?? servers[0];
  // Poll anything that HAS an agent — not just a server whose last stored status was
  // `online`. The stored status is a timestamped observation now, and it can say
  // `offline`/`warning`/`error` while the box is answering perfectly well; gating the
  // live poll on it would blank the metrics for exactly the server an operator opened
  // this page to diagnose, and — because the poll is what refreshes the status — the
  // stale value could then never correct itself. `provisioning` is the one real
  // exclusion: there is no agent on the other end yet.
  const online = Boolean(selected) && selected.status !== "provisioning";

  // Poll the selected server while it is online; append to its rolling buffer.
  // A single measurement takes ~1.2s (network sampling window), longer than the
  // 1s tick, so guard against overlapping requests stacking up: skip a tick if
  // the previous one is still in flight.
  React.useEffect(() => {
    if (!selectedId || !online) return;
    let active = true;
    let busy = false;

    async function tick() {
      if (busy) return;
      busy = true;
      try {
        const res = await gqlAction<{ serverMetrics: ServerMetrics }, ServerMetrics>(
          `query ServerMetrics($serverId: String!) {
            serverMetrics(serverId: $serverId) {
              serverId
              online
              ts
              cpu
              cpuCores
              memUsed
              memTotal
              memPct
              diskUsed
              diskTotal
              diskPct
              netRx
              netTx
              load
              uptimeSec
              containers
            }
          }`,
          { serverId: selectedId },
          (d) => d.serverMetrics,
        );
        if (!active || !res.ok || !res.data) return;
        const sample = res.data;
        setLive((l) => ({ ...l, [selectedId]: sample }));
        // Offline snapshot: no measurement to chart — leave a gap, not a zero.
        if (!sample.online) return;
        setHistory((h) => {
          const prev = h[selectedId] ?? [];
          return { ...h, [selectedId]: [...prev, sample].slice(-MAX_POINTS) };
        });
      } finally {
        busy = false;
      }
    }

    const iv = setInterval(tick, POLL_MS);
    tick();
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [selectedId, online]);

  // Seed the charts from the control plane's buffered history (when "save
  // metrics on server" is on): a reload or a server switch starts from the
  // saved window instead of an empty chart. Merged by timestamp with whatever
  // live samples have already landed — the two writers overlap harmlessly.
  React.useEffect(() => {
    if (!selectedId || !online || !saveMetrics) return;
    let active = true;
    (async () => {
      const res = await gqlAction<
        { serverMetricsHistory: ServerMetrics[] },
        ServerMetrics[]
      >(
        `query ServerMetricsHistory($serverId: String!) {
          serverMetricsHistory(serverId: $serverId) {
            serverId
            online
            ts
            cpu
            cpuCores
            memUsed
            memTotal
            memPct
            diskUsed
            diskTotal
            diskPct
            netRx
            netTx
            load
            uptimeSec
            containers
          }
        }`,
        { serverId: selectedId },
        (d) => d.serverMetricsHistory,
      );
      if (!active || !res.ok || !res.data || res.data.length === 0) return;
      const seeded = res.data;
      setHistory((h) => {
        const byTs = new Map<number, ServerMetrics>();
        // Live samples second so they win a timestamp collision (same data,
        // fresher provenance).
        for (const s of [...seeded, ...(h[selectedId] ?? [])]) byTs.set(s.ts, s);
        const merged = [...byTs.values()]
          .sort((a, b) => a.ts - b.ts)
          .slice(-MAX_POINTS);
        return { ...h, [selectedId]: merged };
      });
    })();
    return () => {
      active = false;
    };
  }, [selectedId, online, saveMetrics]);

  // Flip the instance-wide "save metrics on server" switch. Optimistic (the
  // switch answers immediately) with a revert + the server's message on failure.
  async function toggleSaveMetrics(next: boolean) {
    setSaveMetrics(next);
    setSavingToggle(true);
    try {
      const res = await gqlAction<
        { setSaveMetrics: { saveMetrics: boolean } },
        boolean
      >(
        `mutation SetSaveMetrics($enabled: Boolean!) {
          setSaveMetrics(enabled: $enabled) {
            saveMetrics
          }
        }`,
        { enabled: next },
        (d) => d.setSaveMetrics.saveMetrics,
      );
      if (!res.ok) {
        setSaveMetrics(!next);
        toast.error(res.error);
      }
    } finally {
      setSavingToggle(false);
    }
  }

  // Scroll/keyboard zoom on any chart freezes the shared window to an absolute
  // range; presets, double-click and `0` return to live. useCallback so the
  // handler identity is stable across the 1s poll re-renders.
  const onZoomChange = React.useCallback(
    (next: { windowMs: number; domainEnd: number }) =>
      setView({ mode: "fixed", windowMs: next.windowMs, end: next.domainEnd }),
    [],
  );
  const onResetLive = React.useCallback(
    () => setView((v) => ({ mode: "live", windowMs: v.windowMs })),
    [],
  );
  const domainEnd = view.mode === "fixed" ? view.end : null;

  const samples = history[selectedId] ?? [];
  const lastPoll = live[selectedId];
  // Latest measurement for the tiles — while the agent is unreachable they
  // freeze on the last real values (the status line says so) instead of
  // zeroing. Until the first poll lands, the SSR hint keeps the tiles warm;
  // the charts never see it (it's not a measurement).
  const cur =
    samples[samples.length - 1] ??
    initialMetrics.find((m) => m.serverId === selectedId && m.online) ??
    null;

  // One shared point list feeds every chart; each panel picks its keys.
  const points = React.useMemo(
    () =>
      samples.map((s) => ({
        ts: s.ts,
        values: {
          cpu: s.cpu,
          mem: s.memPct,
          rx: s.netRx,
          tx: s.netTx,
          load1: s.load[0],
          load5: s.load[1],
          load15: s.load[2],
        },
      })),
    [samples],
  );

  // No servers added yet (e.g. straight after first-run setup): nothing to chart.
  // Point the operator at the Servers page to add this host and run its installer.
  // (After all hooks above, so the hook order stays stable across renders.)
  if (!selected) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
          <ServerOff className="size-8 text-muted-foreground" />
          <p className="font-medium">No servers connected</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Add a server from Settings → Servers (start with this host) and run its
            install command to see live metrics here.
          </p>
        </CardContent>
      </Card>
    );
  }

  // The switch is rendered for everyone (so the page never hides where the
  // behavior is controlled) but only `manage_infra` can flip it — the tooltip
  // says so instead of leaving a dead control unexplained.
  const saveSwitch = (
    <div className="flex items-center gap-2">
      <Switch
        id="save-metrics"
        checked={saveMetrics}
        disabled={!canManageInfra || savingToggle}
        onCheckedChange={toggleSaveMetrics}
        aria-label="Save metrics on server"
      />
      <FieldLabel
        htmlFor="save-metrics"
        className="text-sm font-normal text-muted-foreground"
        info={
          <>
            Keeps a rolling ~15-minute metrics history for every server in the
            control plane&apos;s memory, so these charts survive a page reload
            and keep filling while nobody is watching. RAM only (~0.5&nbsp;MB
            per server) — nothing is written to the database, and a
            control-plane restart starts the window over. Turning it off also
            drops the saved history.
          </>
        }
      >
        Save metrics on server
      </FieldLabel>
    </div>
  );

  return (
    <div className="space-y-6">
      {/* Server selector + the instance-wide history switch */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Select value={selected?.id ?? ""} onValueChange={setSelectedId}>
          <SelectTrigger className="w-full sm:w-80" aria-label="Server">
            <SelectValue placeholder="Select a server" />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <span className="flex items-center gap-2">
                  <StatusDot status={s.status} />
                  <span className="font-medium">{serverLabel(s)}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {s.ip}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {canManageInfra ? (
          saveSwitch
        ) : (
          <SimpleTooltip content="Requires the Manage infrastructure capability">
            {/* span so the tooltip still fires over the disabled switch */}
            <span tabIndex={0}>{saveSwitch}</span>
          </SimpleTooltip>
        )}
      </div>

      {!online || !cur ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <ServerOff className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">No live metrics</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              {selected?.status === "provisioning"
                ? "This server is still provisioning. Metrics appear once the agent is online."
                : "This server's agent isn't answering. Metrics resume as soon as it does."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Live status line + chart time window (scopes every chart below) */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {lastPoll && !lastPoll.online ? (
              <div className="flex items-center gap-2 text-xs text-[var(--warning)]">
                <span className="inline-flex size-2 rounded-full bg-[var(--warning)]" />
                Agent not answering — showing data up to {fmtClock(cur.ts)}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-[var(--success)] opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-[var(--success)]" />
                </span>
                Live · sampling every {POLL_MS / 1000}s
              </div>
            )}
            <div className="flex items-center gap-2">
              {/* Frozen by a zoom: show the span and a one-click way back to live. */}
              {view.mode === "fixed" && (
                <button
                  type="button"
                  onClick={onResetLive}
                  title="Resume live (or double-click a chart)"
                  className="flex items-center gap-1.5 rounded-md border border-[var(--warning)]/40 bg-[var(--warning)]/10 px-2.5 py-1 text-xs text-[var(--warning)] transition-colors hover:bg-[var(--warning)]/20"
                >
                  <RadioTower className="size-3.5" />
                  Zoomed · {fmtSpan(view.windowMs)} — resume live
                </button>
              )}
              <div
                className="flex items-center gap-0.5 rounded-lg border p-0.5"
                role="group"
                aria-label="Chart time window"
              >
                {WINDOWS.map((w) => {
                  const active = view.mode === "live" && view.windowMs === w.ms;
                  return (
                    <button
                      key={w.label}
                      type="button"
                      onClick={() => setView({ mode: "live", windowMs: w.ms })}
                      aria-pressed={active}
                      className={cn(
                        "rounded-md px-2.5 py-1 text-xs transition-colors",
                        active
                          ? "bg-secondary font-medium"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      Last {w.label}
                    </button>
                  );
                })}
              </div>
              <InfoTip
                label="Chart zoom help"
                content={
                  <>
                    Scroll on any chart to zoom the time axis around the cursor;
                    <kbd>+</kbd>/<kbd>−</kbd> zoom from the centre. Zooming freezes
                    the range on every chart — double-click a chart, press{" "}
                    <kbd>0</kbd>, or pick a preset to resume live.
                  </>
                }
              />
            </div>
          </div>

          {/* Current-value tiles */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              icon={Cpu}
              label="CPU"
              value={`${cur.cpu.toFixed(1)}%`}
              sub={`${cur.cpuCores} cores · load ${cur.load[0].toFixed(2)}`}
              pct={cur.cpu}
            />
            <StatTile
              icon={MemoryStick}
              label="Memory"
              value={`${cur.memPct.toFixed(1)}%`}
              sub={`${formatBytes(cur.memUsed)} / ${formatBytes(cur.memTotal)}`}
              pct={cur.memPct}
            />
            <StatTile
              icon={HardDrive}
              label="Disk"
              value={`${cur.diskPct.toFixed(1)}%`}
              sub={`${formatBytes(cur.diskUsed)} / ${formatBytes(cur.diskTotal)}`}
              pct={cur.diskPct}
            />
            <Card>
              <CardContent className="space-y-1.5 p-4">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Network className="size-4" />
                  <span className="text-xs">Network</span>
                </div>
                <div className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
                  <ArrowDown className="size-4 text-[var(--success)]" />
                  {formatBytes(cur.netRx)}/s
                </div>
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <ArrowUp className="size-4" />
                  {formatBytes(cur.netTx)}/s
                </div>
              </CardContent>
            </Card>
          </div>

          {/* Real-time charts */}
          <div className="grid gap-4 lg:grid-cols-2">
            <ChartCard
              title="CPU usage"
              caption={`${cur.cpu.toFixed(1)}% of ${cur.cpuCores} cores`}
            >
              <TimeSeriesChart
                unit="percent"
                windowMs={view.windowMs}
                domainEnd={domainEnd}
                onZoomChange={onZoomChange}
                onResetLive={onResetLive}
                points={points}
                series={[
                  { key: "cpu", label: "CPU", color: "var(--chart-1)", fill: true },
                ]}
                ariaLabel={`CPU usage over time, currently ${cur.cpu.toFixed(1)}%`}
              />
            </ChartCard>

            <ChartCard
              title="Memory usage"
              caption={`${formatBytes(cur.memUsed)} of ${formatBytes(cur.memTotal)} · ${cur.memPct.toFixed(1)}%`}
            >
              <TimeSeriesChart
                unit="percent"
                windowMs={view.windowMs}
                domainEnd={domainEnd}
                onZoomChange={onZoomChange}
                onResetLive={onResetLive}
                points={points}
                series={[
                  { key: "mem", label: "Memory", color: "var(--chart-1)", fill: true },
                ]}
                ariaLabel={`Memory usage over time, currently ${cur.memPct.toFixed(1)}%`}
              />
            </ChartCard>

            <ChartCard title="Network I/O">
              <TimeSeriesChart
                unit="bytesPerSec"
                windowMs={view.windowMs}
                domainEnd={domainEnd}
                onZoomChange={onZoomChange}
                onResetLive={onResetLive}
                points={points}
                series={[
                  { key: "rx", label: "↓ Received", color: "var(--chart-1)" },
                  { key: "tx", label: "↑ Sent", color: "var(--chart-2)" },
                ]}
                ariaLabel="Network throughput over time, received and sent bytes per second"
              />
            </ChartCard>

            <ChartCard title="Load average">
              <TimeSeriesChart
                unit="count"
                windowMs={view.windowMs}
                domainEnd={domainEnd}
                onZoomChange={onZoomChange}
                onResetLive={onResetLive}
                points={points}
                series={[
                  { key: "load1", label: "1m", color: "var(--chart-1)" },
                  { key: "load5", label: "5m", color: "var(--chart-2)" },
                  { key: "load15", label: "15m", color: "var(--chart-3)" },
                ]}
                ariaLabel={`System load average over time, 1, 5 and 15 minutes, across ${cur.cpuCores} cores`}
              />
            </ChartCard>
          </div>

          {/* Info strip */}
          <Card>
            <CardContent className="grid grid-cols-2 gap-4 py-4 sm:grid-cols-4">
              <InfoItem icon={Clock} label="Uptime" value={fmtUptime(cur.uptimeSec)} />
              <InfoItem icon={Boxes} label="Containers" value={`${cur.containers}`} />
              <InfoItem
                icon={Gauge}
                label="Load (1/5/15m)"
                value={cur.load.map((l) => l.toFixed(2)).join(" / ")}
              />
              <InfoItem
                icon={Cpu}
                label="Docker"
                value={selected.dockerVersion || "—"}
              />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  pct,
}: {
  icon: typeof Cpu;
  label: string;
  value: string;
  sub: string;
  pct: number;
}) {
  const over = pct > 80;
  return (
    <Card>
      <CardContent className="space-y-2 p-4">
        <div className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="size-4" />
          <span className="text-xs">{label}</span>
        </div>
        <p className="text-2xl font-semibold tracking-tight">{value}</p>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              over ? "bg-[var(--warning)]" : "bg-foreground/80",
            )}
            style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
          />
        </div>
        <p className="text-xs text-muted-foreground">{sub}</p>
      </CardContent>
    </Card>
  );
}

function ChartCard({
  title,
  caption,
  className,
  children,
}: {
  title: string;
  /** Live current-value readout. Multi-series charts omit it — their legend carries the values. */
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

function InfoItem({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Cpu;
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

/** Wall-clock HH:MM:SS for "showing data up to …". */
function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function fmtUptime(sec: number): string {
  if (sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
