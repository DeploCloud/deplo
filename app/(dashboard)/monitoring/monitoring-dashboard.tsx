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
import { Card, CardContent } from "@/components/ui/card";
import { TimeSeriesChart } from "@/components/monitoring/time-series-chart";
import { GaugeTile } from "@/components/monitoring/radial-gauge";
import { MonitoringGraphic } from "@/components/monitoring/monitoring-graphic";
import { EmptyState } from "@/components/shared/empty-state";
import {
  FleetList,
  ManageServerButton,
  type FleetRow,
} from "@/components/monitoring/fleet-list";
import { ServerPicker } from "@/components/monitoring/server-picker";
import {
  ChartCard,
  InfoItem,
  LiveStatusLine,
  MAX_POINTS,
  pollIntervalFor,
  STALE_AFTER_MS,
  WindowSelector,
  WINDOWS,
} from "@/components/monitoring/dashboard-parts";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerMetrics } from "@/lib/data/monitoring";
import type { ServerStatus } from "@/lib/types";
import { formatBytes, serverLabel } from "@/lib/utils";

interface ServerLite {
  id: string;
  name: string;
  status: ServerStatus;
  ip: string;
  dockerVersion: string;
}

const SERVER_FIELDS = `serverId online ts cpu cpuCores memUsed memTotal memPct
  memFree memCache diskUsed diskTotal diskPct netRx netTx load uptimeSec
  containers agentVersion expectedAgentVersion source`;
const FLEET_FIELDS = `serverId online ts cpu memPct diskPct containers
  agentVersion expectedAgentVersion source spark { ts cpu mem }`;

export function MonitoringDashboard({
  servers,
  initialHistory,
  initialFleet,
  canManageServers,
}: {
  servers: ServerLite[];
  /** The FIRST server's buffered window, so its charts paint full on the first
   *  render. Real measurements: there is no synthetic snapshot any more. */
  initialHistory: ServerMetrics[];
  /** Every server's headline reading, so the fleet list paints full too. */
  initialFleet: FleetRow[];
  /** Cosmetic gate on the link to a server's own page (instance admins only). */
  canManageServers: boolean;
}) {
  const [selectedId, setSelectedId] = React.useState(servers[0]?.id ?? "");
  const [windowMs, setWindowMs] = React.useState<number>(WINDOWS[0].ms);
  // Chart history holds live MEASUREMENTS only. The SSR hint (stored status, zeroed
  // net/load) is a placeholder, not a measurement - charting it would draw a fake dip
  // to 0.
  const [history, setHistory] = React.useState<Record<string, ServerMetrics[]>>(
    () =>
      initialHistory.length && servers[0]
        ? { [servers[0].id]: initialHistory }
        : {},
  );
  const [fleet, setFleet] = React.useState<Record<string, FleetRow>>(() =>
    Object.fromEntries(initialFleet.map((r) => [r.serverId, r])),
  );
  // A render clock, advanced by the read loop below, so staleness can assert
  // itself even when reads stop succeeding (nothing else would re-render).
  const [now, setNow] = React.useState<number>(() => Date.now());

  const selected = servers.find((s) => s.id === selectedId) ?? servers[0];
  // One host is not a fleet: with nothing to pick, the list is first-run surface.
  const showFleet = servers.length > 1;
  // Read at the rate the samples ARRIVE, not a fixed 1s - see pollIntervalFor.
  const pollMs = React.useMemo(
    () => pollIntervalFor((history[selectedId] ?? []).map((x) => x.ts)),
    [history, selectedId],
  );
  // Read the buffer for anything that HAS an agent, not just a server whose last
  // stored status was `online`.
  const online = Boolean(selected) && selected.status !== "provisioning";

  // ONE read, on POLL_MS, of the control plane's ring buffers. The fleet rows ride
  // the same document rather than a second request: both are RAM reads on the
  // control plane, and one round trip cannot interleave two clocks.
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
          {
            serverMetricsHistory: ServerMetrics[];
            fleetMetrics?: FleetRow[];
          },
          { history: ServerMetrics[]; fleet: FleetRow[] }
        >(
          `query MonitoringTick($serverId: String!, $withFleet: Boolean!) {
            serverMetricsHistory(serverId: $serverId) { ${SERVER_FIELDS} }
            fleetMetrics @include(if: $withFleet) { ${FLEET_FIELDS} }
          }`,
          { serverId: selectedId, withFleet: showFleet },
          (d) => ({
            history: d.serverMetricsHistory,
            fleet: d.fleetMetrics ?? [],
          }),
        );
        if (!active || !res.ok || !res.data) return;
        if (res.data.fleet.length)
          setFleet(
            Object.fromEntries(res.data.fleet.map((r) => [r.serverId, r])),
          );
        const seeded = res.data.history;
        if (seeded.length === 0) return;
        setHistory((h) => {
          const prev = h[selectedId] ?? [];
          const byTs = new Map<number, ServerMetrics>();
          // Buffer samples second so they win a timestamp collision - same
          // data, authoritative provenance.
          for (const s of [...prev, ...seeded]) byTs.set(s.ts, s);
          const merged = [...byTs.values()]
            .sort((a, b) => a.ts - b.ts)
            .slice(-MAX_POINTS);
          // Reads run faster than the agent's cadence, so most of them return a window
          // identical to the one already on screen.
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
    const iv = setInterval(seed, pollMs);
    // Read on wake as well as on the timer. A soft-nav back or a bfcache/Router-Cache
    // restore may not remount this component, so a mount-only read would never re-run;
    // `pageshow` covers the bfcache restore.
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
  }, [selectedId, online, pollMs, showFleet]);

  const samples = history[selectedId] ?? [];
  // Latest MEASUREMENT for the tiles. While nothing is arriving they freeze on the
  // last real values (the status line says so) instead of zeroing, and before the
  // first one there is an honest waiting state rather than a fabricated snapshot.
  const cur = samples[samples.length - 1] ?? null;
  // "Live" is a claim about the FEED, not about the last request: a read that
  // succeeds and returns the same frame it returned a minute ago is not live.
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
      <EmptyState
        icon={ServerOff}
        title="No servers yet"
        description="Add a server to start seeing live CPU, memory, disk and network."
      />
    );
  }

  return (
    <div className="space-y-6">
      {showFleet && (
        <FleetList
          servers={servers}
          rows={fleet}
          selectedId={selected.id}
          onSelect={setSelectedId}
          canManageServers={canManageServers}
        />
      )}

      {!online || !cur ? (
        <EmptyState
          graphic={<MonitoringGraphic />}
          title="No live metrics"
          docs="monitoring.overview"
          description={
            selected.status === "provisioning"
              ? "This server is still provisioning. Metrics appear once its agent is online."
              : "Nothing has arrived from this server yet. Metrics appear as soon as it starts reporting."
          }
        />
      ) : (
        <>
          {/* Whose panels these are, whether the feed is live, and the window
              that scopes every chart below. */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              {showFleet ? (
                <ServerPicker
                  servers={servers}
                  rows={fleet}
                  selectedId={selected.id}
                  onSelect={setSelectedId}
                />
              ) : (
                // One host: there is nothing to pick, so the name is just a
                // name - and its Manage link has no row to live on.
                <>
                  <span className="text-sm font-medium">
                    {serverLabel(selected)}
                  </span>
                  {canManageServers && (
                    <ManageServerButton id={selected.id} className="mr-0" />
                  )}
                </>
              )}
              {/**
               * The shared status line, not a local copy of it: the per-app Monitoring tab shows
               * the same claim, and two hand-maintained versions of "is this feed live?"
               */}
              <LiveStatusLine stale={stale} asOf={cur.ts} />
            </div>
            <WindowSelector windowMs={windowMs} onChange={setWindowMs} />
          </div>

          {/* Saturation against the machine - three arcs asking one question. */}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <GaugeTile
              icon={Cpu}
              label="CPU"
              value={cur.cpu}
              full={100}
              display={`${cur.cpu.toFixed(1)}%`}
              caption={`${cur.cpuCores} cores · load ${cur.load[0].toFixed(2)}`}
            />
            <GaugeTile
              icon={MemoryStick}
              label="Memory"
              value={cur.memPct}
              full={100}
              display={`${cur.memPct.toFixed(1)}%`}
              caption={`${formatBytes(cur.memUsed)} of ${formatBytes(cur.memTotal)}`}
              info={
                cur.memCache > 0 ? (
                  <>
                    <p>
                      processes{" "}
                      {formatBytes(
                        Math.max(0, cur.memTotal - cur.memFree - cur.memCache),
                      )}{" "}
                      · cache {formatBytes(cur.memCache)} · free{" "}
                      {formatBytes(cur.memFree)}
                    </p>
                    <p className="mt-1">
                      The figure above counts cache the kernel cannot reclaim as
                      used, the same way `free` does. htop counts all cache as
                      free, so it reads lower.
                    </p>
                  </>
                ) : undefined
              }
            />
            <GaugeTile
              icon={HardDrive}
              label="Disk"
              value={cur.diskPct}
              full={100}
              display={`${cur.diskPct.toFixed(1)}%`}
              caption={`${formatBytes(cur.diskUsed)} of ${formatBytes(cur.diskTotal)}`}
            />
            {/* Throughput has no ceiling to fill, so it stays a reading. */}
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
                  {
                    key: "cpu",
                    label: "CPU",
                    color: "var(--chart-1)",
                    fill: true,
                  },
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
                  {
                    key: "mem",
                    label: "Memory",
                    color: "var(--chart-1)",
                    fill: true,
                  },
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
              <InfoItem
                icon={Clock}
                label="Uptime"
                value={fmtUptime(cur.uptimeSec)}
              />
              <InfoItem
                icon={Boxes}
                label="Containers"
                value={`${cur.containers}`}
              />
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

function fmtUptime(sec: number): string {
  if (sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}
