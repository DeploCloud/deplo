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
import { FieldLabel } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { StatusDot } from "@/components/shared/status-badge";
import { TimeSeriesChart } from "@/components/monitoring/time-series-chart";
import {
  LiveStatusLine,
  MAX_POINTS,
  POLL_MS,
  STALE_AFTER_MS,
  WINDOWS,
} from "@/components/monitoring/dashboard-parts";
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
  const [windowMs, setWindowMs] = React.useState<number>(WINDOWS[0].ms);
  const [saveMetrics, setSaveMetrics] = React.useState(initialSaveMetrics);
  const [savingToggle, setSavingToggle] = React.useState(false);
  // Chart history holds live MEASUREMENTS only. The SSR hint (stored status,
  // zeroed net/load) is a placeholder, not a measurement — charting it would
  // draw a fake dip to 0. The server-side buffer only ever admits real
  // measurements, so an outage arrives here as widened spacing (an honest gap),
  // never as a row of zeros.
  const [history, setHistory] = React.useState<Record<string, ServerMetrics[]>>({});
  // A render clock, advanced by the read loop below, so staleness can assert
  // itself even when reads stop succeeding (nothing else would re-render).
  const [now, setNow] = React.useState<number>(() => Date.now());

  const selected = servers.find((s) => s.id === selectedId) ?? servers[0];
  // Read the buffer for anything that HAS an agent — not just a server whose last
  // stored status was `online`. The stored status is a timestamped observation, and
  // it can say `offline`/`warning`/`error` while the box is streaming perfectly
  // well; gating the read on it would blank the charts for exactly the server an
  // operator opened this page to diagnose, while the supervisor sat there holding a
  // healthy stream from it. `provisioning` is the one real exclusion: there is no
  // agent on the other end yet, so no stream and nothing buffered.
  const online = Boolean(selected) && selected.status !== "provisioning";

  // ONE read, on POLL_MS, of the control plane's ring buffer.
  //
  // What this replaced: a 1s `serverMetrics` poll whose every tick DIALLED this
  // host and made it measure — the fleet's telemetry cost scaled with how many
  // operators had the page open — plus a slower history re-merge beside it to
  // repair the holes that append-only feed left behind. The telemetry-stream
  // supervisor now holds one long-lived stream per host and fills the buffer at
  // the agent's own cadence, so the MERGE is the feed: every point drawn comes
  // from the buffer, and a failed request, a throttled tab or a stretch when
  // nobody was watching resolves on the next read instead of scarring the
  // window permanently.
  //
  // Still gated on `online`: nothing streams from a host that has no agent yet.
  React.useEffect(() => {
    if (!selectedId || !online) return;
    let active = true;
    // A buffer read is cheap but not instant (auth + team scoping). Keep the
    // in-flight guard so ticks cannot stack into a queue on a slow link and
    // land out of order.
    let busy = false;
    const seed = async () => {
      setNow(Date.now());
      if (busy) return;
      busy = true;
      try {
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
          const prev = h[selectedId] ?? [];
          const byTs = new Map<number, ServerMetrics>();
          // Buffer samples second so they win a timestamp collision — same
          // data, authoritative provenance.
          for (const s of [...prev, ...seeded]) byTs.set(s.ts, s);
          const merged = [...byTs.values()]
            .sort((a, b) => a.ts - b.ts)
            .slice(-MAX_POINTS);
          // Reads run faster than the agent's cadence, so most of them return a
          // window identical to the one already on screen. Keep the previous
          // ARRAY in that case: a fresh identity would invalidate the points
          // memo and redraw every chart several times per new measurement.
          if (
            merged.length === prev.length &&
            merged[merged.length - 1]?.ts === prev[prev.length - 1]?.ts
          ) {
            return h;
          }
          return { ...h, [selectedId]: merged };
        });
      } finally {
        busy = false;
      }
    };
    void seed();
    const iv = setInterval(seed, POLL_MS);
    // Read on wake as well as on the timer. A backgrounded tab has its timers
    // clamped to roughly 1/min, which is PRECISELY the case server-side
    // buffering exists to cover: the frames kept arriving while the tab slept,
    // so an immediate read on return paints the whole continuous window at once
    // instead of showing a false hole that fills in over the next minute. A
    // soft-nav back or a bfcache/Router-Cache restore may not remount this
    // component, so a mount-only read would never re-run; `pageshow` covers the
    // bfcache restore.
    const onWake = () => {
      if (document.visibilityState !== "hidden") void seed();
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("focus", onWake);
    window.addEventListener("pageshow", onWake);
    return () => {
      active = false;
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("focus", onWake);
      window.removeEventListener("pageshow", onWake);
    };
  }, [selectedId, online]);

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

  const samples = history[selectedId] ?? [];
  // Latest measurement for the tiles — while nothing is arriving they freeze on
  // the last real values (the status line says so) instead of zeroing. Until
  // the first read lands, the SSR hint keeps the tiles warm; the charts never
  // see it (it's not a measurement).
  const cur =
    samples[samples.length - 1] ??
    initialMetrics.find((m) => m.serverId === selectedId && m.online) ??
    null;
  // "Live" is a claim about the FEED, not about the last request: a read that
  // succeeds and returns the same frame it returned a minute ago is not live.
  // Judged at the same threshold the charts band "No data" at, so the header
  // and the chart below it can never contradict each other.
  const stale = cur ? now - cur.ts > STALE_AFTER_MS : false;

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
                ? "This server is still provisioning. Metrics appear once its agent is online."
                : "Nothing has arrived from this server yet. Metrics appear as soon as it starts reporting."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Live status line + chart time window (scopes every chart below) */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {/* The shared status line, not a local copy of it: the per-app
                Monitoring tab shows the same claim, and two hand-maintained
                versions of "is this feed live?" is exactly how one of them ends
                up still promising a sampling rate nothing samples at. */}
            <LiveStatusLine stale={stale} asOf={cur.ts} />
            <div
              className="flex items-center gap-0.5 rounded-lg border p-0.5"
              role="group"
              aria-label="Chart time window"
            >
              {WINDOWS.map((w) => (
                <button
                  key={w.label}
                  type="button"
                  onClick={() => setWindowMs(w.ms)}
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
                windowMs={windowMs}
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
                windowMs={windowMs}
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
                windowMs={windowMs}
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
                windowMs={windowMs}
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

function fmtUptime(sec: number): string {
  if (sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
