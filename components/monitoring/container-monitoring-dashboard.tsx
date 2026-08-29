"use client";

import * as React from "react";
import {
  Cpu,
  MemoryStick,
  Network,
  ListTree,
  ArrowDown,
  ArrowUp,
  ArrowUpCircle,
  Gauge,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { TimeSeriesChart } from "@/components/monitoring/time-series-chart";
import { GaugeTile } from "@/components/monitoring/radial-gauge";
import { MonitoringGraphic } from "@/components/monitoring/monitoring-graphic";
import { NotRunningGraphic } from "@/components/apps/not-running-graphic";
import { EmptyState } from "@/components/shared/empty-state";
import {
  StatTile,
  ChartCard,
  WindowSelector,
  LiveStatusLine,
  WINDOWS,
  pollIntervalFor,
  MAX_POINTS,
  STALE_AFTER_MS,
} from "@/components/monitoring/dashboard-parts";
import { gqlAction } from "@/lib/graphql-client";
import { cn, formatBytes } from "@/lib/utils";
import type { ResourceLimits } from "@/lib/types";

/** "0.5 core" / "1 core" / "2 cores" from a fractional core count. */
function fmtCores(cores: number): string {
  const s = Number.isInteger(cores)
    ? String(cores)
    : String(Number(cores.toFixed(3)));
  return `${s} core${cores === 1 ? "" : "s"}`;
}

/** A configured memory cap. The NUMBER is the one the operator typed in
 *  Settings → Resources; the unit is binary like every other byte in the app. */
function fmtMemMb(mb: number): string {
  return mb >= 1024 ? `${Number((mb / 1024).toFixed(2))} GiB` : `${mb} MiB`;
}

/** A stack's CPU in cores, but ONLY once the percentage stops explaining itself.
 *  `cpu` is a percentage of ONE core - htop's and `docker stats`' convention - so
 *  299% needs saying as 3 cores, while 0.9% just reads "0.01 of 8 cores". */
export function fmtCoresUsed(cpuPct: number, hostCores: number): string | null {
  if (hostCores <= 0 || cpuPct < 100) return null;
  return `${(cpuPct / 100).toFixed(2)} of ${hostCores} core${hostCores === 1 ? "" : "s"}`;
}

/** Who a container shares its network counters with. Two containers in one
 *  namespace read the SAME bytes, so the stack total counts them once and the
 *  table has to say why a row looks like a duplicate. */
function netNoteFor(c: InstanceMetrics, all: InstanceMetrics[]): string | null {
  if (c.netNsHost) return "host network";
  if (!c.netNsId) return null;
  const owner = all.find((o) => o.running && o.netNsId === c.netNsId);
  return owner && owner.name !== c.name
    ? `network shared with ${owner.name}`
    : null;
}

/* The client-side shape of a ContainerMetrics / ContainerMetricsSample (the
 * server types are `server-only`, so the client redeclares the wire shape). */
interface InstanceMetrics {
  name: string;
  running: boolean;
  cpu: number;
  memUsed: number;
  memLimit: number;
  memPct: number;
  netRx: number;
  netTx: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
  /** Raw docker state; empty from an agent too old to send it. */
  state: string;
  /** healthy | unhealthy | starting. EMPTY means no healthcheck at all. */
  health: string;
  restartCount: number;
  netNsId: number;
  netNsHost: boolean;
}
export interface ContainerSample {
  online: boolean;
  ts: number;
  cpu: number;
  memUsed: number;
  memLimit: number;
  memPct: number;
  netRx: number; // cumulative bytes
  netTx: number;
  blockRead: number;
  blockWrite: number;
  pids: number;
  running: number;
  containers: number;
  hostCores: number;
}
interface ContainerLive extends ContainerSample {
  unsupported: boolean;
  instances: InstanceMetrics[];
}

const SAMPLE_FIELDS = `online ts cpu memUsed memLimit memPct netRx netTx blockRead blockWrite pids running containers hostCores`;
const LIVE_FIELDS = `${SAMPLE_FIELDS} unsupported instances { name running cpu memUsed memLimit memPct netRx netTx blockRead blockWrite pids state health restartCount netNsId netNsHost }`;

/** Per-second rate from two cumulative-counter samples; a counter reset
 *  (container restart, so the total dropped) clamps to 0 rather than a spike. */
function rate(cur: number, prev: number, dtSec: number): number {
  if (dtSec <= 0) return 0;
  return Math.max(0, (cur - prev) / dtSec);
}

/**
 * The per-app / per-database Monitoring tab.
 */
export function ContainerMonitoringDashboard({
  kind,
  id,
  initialHistory,
  resources,
}: {
  kind: "app" | "database";
  id: string;
  /** The buffered window, to render a full chart on the very first paint. */
  initialHistory: ContainerSample[];
  /** The stack's configured resource limits, so the % gauges read against the
   *  cap (not the whole host) - null when uncapped. */
  resources: ResourceLimits | null;
}) {
  const noun = kind === "app" ? "app" : "database";
  const metricsField = kind === "app" ? "appMetrics" : "databaseMetrics";
  const historyField =
    kind === "app" ? "appMetricsHistory" : "databaseMetricsHistory";
  const idArg = kind === "app" ? "appId" : "databaseId";

  // Configured PER-CONTAINER caps.
  const cpuLimitCores =
    resources?.cpuMilli != null ? resources.cpuMilli / 1000 : null;
  const memLimitMb = resources?.memoryMb ?? null;
  const memLimitBytes = memLimitMb != null ? memLimitMb * 1024 * 1024 : null;
  const pidsLimit = resources?.pidsLimit ?? null;
  const hasLimits =
    cpuLimitCores != null || memLimitBytes != null || pidsLimit != null;
  // Aggregate = per-container cap × how many are running; the app-total usage is
  // summed over those same containers. running 0 ⇒ leave usage host-relative.
  const cpuOf = (cpu: number, running: number) =>
    cpuLimitCores && running > 0 ? cpu / (cpuLimitCores * running) : cpu;
  const memPctOf = (memUsed: number, running: number, dockerPct: number) =>
    memLimitBytes && running > 0
      ? (memUsed / (memLimitBytes * running)) * 100
      : dockerPct;

  const [windowMs, setWindowMs] = React.useState<number>(WINDOWS[0].ms);
  // The live-vs-history split is kept, but both halves now come from the same buffer:
  // `samples` is the SERIES the charts draw, `last` is the latest-value CELL - the
  // per-container breakdown and the `unsupported` flag, which are a live table rather
  const [samples, setSamples] = React.useState<ContainerSample[]>(() =>
    initialHistory.filter((s) => s.online),
  );
  const [last, setLast] = React.useState<ContainerLive | null>(null);
  // A render clock, advanced by the read loop below.
  const [now, setNow] = React.useState<number>(() => Date.now());
  // Read at the rate the samples ARRIVE, not a fixed 1s - see pollIntervalFor.
  const pollMs = React.useMemo(
    () => pollIntervalFor(samples.map((x) => x.ts)),
    [samples],
  );

  // ONE read, on POLL_MS, for both halves. They are two reads of the same in-RAM
  // buffer; splitting them into two timers would double the request rate for no extra
  // freshness and let the tiles and the charts land a beat apart.
  React.useEffect(() => {
    let active = true;
    // A read is cheap but not instant (auth + team scoping). Keep the in-flight
    // guard: on a slow link, ticks would otherwise stack into a queue that
    // outlives the interval and lands out of order.
    let busy = false;

    const read = async () => {
      setNow(Date.now());
      if (busy) return;
      busy = true;
      try {
        const res = await gqlAction<
          Record<string, ContainerLive | ContainerSample[] | null>,
          { live: ContainerLive | null; history: ContainerSample[] }
        >(
          `query Metrics($id: String!) {
            ${metricsField}(${idArg}: $id) { ${LIVE_FIELDS} }
            ${historyField}(${idArg}: $id) { ${SAMPLE_FIELDS} }
          }`,
          { id },
          (d) => ({
            live: (d[metricsField] as ContainerLive | null) ?? null,
            history: (d[historyField] as ContainerSample[]) ?? [],
          }),
        );
        if (!active || !res.ok || !res.data) return;
        setLast(res.data.live);
        if (res.data.history.length === 0) return;
        // Keep every recorded measurement, `running: 0` included.
        const fresh = res.data.history.filter((s) => s.online);
        setSamples((prev) => {
          const byTs = new Map<number, ContainerSample>();
          // Buffer samples second so they win a timestamp collision - same
          // data, authoritative provenance.
          for (const s of [...prev, ...fresh]) byTs.set(s.ts, s);
          const merged = [...byTs.values()]
            .sort((a, b) => a.ts - b.ts)
            .slice(-MAX_POINTS);
          // Reads run faster than the agent's cadence, so most of them return a window
          // identical to the one already on screen.
          const head = merged[merged.length - 1];
          const prevHead = prev[prev.length - 1];
          if (merged.length === prev.length && head?.ts === prevHead?.ts) {
            return prev;
          }
          return merged;
        });
      } finally {
        busy = false;
      }
    };

    void read();
    const iv = setInterval(read, pollMs);
    // Read on wake as well as on the timer. A soft-nav back or a bfcache restore may
    // not remount this component, so a mount-only read would never re-run - `pageshow`
    // covers the bfcache case.
    const onWake = () => {
      if (document.visibilityState !== "hidden") void read();
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
  }, [id, metricsField, historyField, idArg, pollMs]);

  // One shared point list feeds every chart; net/block are cumulative counters,
  // so each point's rate is derived from the previous sample's delta.
  const points = React.useMemo(
    () =>
      samples.map((s, i) => {
        const prev = samples[i - 1];
        const dt = prev ? (s.ts - prev.ts) / 1000 : 0;
        return {
          ts: s.ts,
          values: {
            // CPU/mem rescaled to the aggregate caps (per-container cap × that sample's running
            // count) so the charts' 0-100% axis means "% of the limit" when one is set (inlined
            // from cpuOf/memPctOf so the memo depends only on the primitive caps).
            cpu:
              cpuLimitCores && s.running > 0
                ? s.cpu / (cpuLimitCores * s.running)
                : s.cpu,
            mem:
              memLimitBytes && s.running > 0
                ? (s.memUsed / (memLimitBytes * s.running)) * 100
                : s.memPct,
            rx: prev ? rate(s.netRx, prev.netRx, dt) : 0,
            tx: prev ? rate(s.netTx, prev.netTx, dt) : 0,
            bread: prev ? rate(s.blockRead, prev.blockRead, dt) : 0,
            bwrite: prev ? rate(s.blockWrite, prev.blockWrite, dt) : 0,
          },
        };
      }),
    [samples, cpuLimitCores, memLimitBytes],
  );

  const cur = samples[samples.length - 1] ?? null;
  // Current values, rescaled to the aggregate caps where set.
  const curCpu = cur ? cpuOf(cur.cpu, cur.running) : 0;
  const curMemPct = cur ? memPctOf(cur.memUsed, cur.running, cur.memPct) : 0;
  // The stack's aggregate budget = per-container cap × running count, for the
  // labels/captions (so a 3-container stack reads "0.75 cores", not "0.25").
  // Clamp the multiplier to ≥1 so the label reads sanely between polls.
  const runningCount = cur?.running ?? 0;
  const capMult = Math.max(runningCount, 1);
  const multiContainer = runningCount > 1;
  const cpuLimitAggCores =
    cpuLimitCores != null ? cpuLimitCores * capMult : null;
  const memLimitAggMb = memLimitMb != null ? memLimitMb * capMult : null;
  const pidsLimitAgg = pidsLimit != null ? pidsLimit * capMult : null;
  // Uncapped, the denominator is the MACHINE's RAM - counted once, so it does not
  // move when a container stops. When capped, the aggregate cap above wins.
  const memDenom = cur?.memLimit ?? 0;
  // The arc's ceiling: the configured cap when there is one, else the whole
  // machine. `curCpu` is a percentage of ONE core when uncapped, so the display
  // divides by the core count to agree with the arc - the chart below keeps the
  // per-core reading, and both captions name the cores that bridge them.
  const hostCores = cur?.hostCores ?? 0;
  const cpuAgainstHost = cpuLimitAggCores == null && hostCores > 0;
  const cpuGaugeFull = cpuAgainstHost ? hostCores * 100 : 100;
  const cpuDisplay = cpuAgainstHost
    ? `${(curCpu / hostCores).toFixed(1)}%`
    : `${curCpu.toFixed(1)}%`;
  // Current network / block rates from the last two chart samples.
  const prev = samples[samples.length - 2];
  const dt = cur && prev ? (cur.ts - prev.ts) / 1000 : 0;
  const curNetRx = cur && prev ? rate(cur.netRx, prev.netRx, dt) : 0;
  const curNetTx = cur && prev ? rate(cur.netTx, prev.netTx, dt) : 0;

  // The compact "limits apply" note surfaced above the tiles.
  const limitParts = [
    cpuLimitCores != null ? `CPU ${fmtCores(cpuLimitCores)}` : null,
    memLimitMb != null ? `Memory ${fmtMemMb(memLimitMb)}` : null,
    pidsLimit != null ? `PIDs ${pidsLimit}` : null,
  ].filter(Boolean) as string[];

  // "Live" is a claim about the FEED, not about the last request: a read that
  // succeeds and returns the same frame it returned a minute ago is not live.
  const stale =
    Boolean(last && !last.online) ||
    (cur ? now - cur.ts > STALE_AFTER_MS : false);
  // A stopped stack reports real zeros, and the buffer records them, so without
  // this the tab drew 16 minutes of flat zero under a "Live" line before the
  // samples aged out and the empty state below finally appeared.
  const latest = last ?? cur;
  const nothingRunning = Boolean(
    latest && latest.containers > 0 && latest.running === 0,
  );

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {cur ? (
        <LiveStatusLine stale={stale} asOf={cur.ts} />
      ) : (
        <span className="text-xs text-muted-foreground">
          Live container metrics
        </span>
      )}
      {cur && <WindowSelector windowMs={windowMs} onChange={setWindowMs} />}
    </div>
  );

  // Empty states, in priority order.
  let body: React.ReactNode;
  if (last?.unsupported) {
    body = (
      <EmptyState
        icon={ArrowUpCircle}
        title="Update the agent"
        description={`The agent on this ${noun}'s server is too old to report per-container metrics. Update the agent on that server (Servers → the server → update) to enable this tab.`}
      />
    );
  } else if (!cur) {
    if (last && !last.online) {
      // "Offline" now means the control plane holds NO frame for this stack.
      body = (
        <EmptyState
          graphic={<MonitoringGraphic />}
          title="No metrics yet"
          docs="monitoring.overview"
          description={`Nothing has arrived for this ${noun}. Metrics appear as soon as its server starts reporting - check that server on the Servers page if this persists.`}
        />
      );
    } else if (last && last.running === 0) {
      body = (
        <EmptyState
          graphic={<NotRunningGraphic />}
          title="Not running"
          description={`This ${noun} isn't running, so there's nothing to measure. Start it to see live resource usage here.`}
        />
      );
    } else {
      body = (
        <EmptyState
          graphic={<MonitoringGraphic />}
          title="Collecting"
          description="Waiting for the first measurement to arrive from this server."
        />
      );
    }
  } else if (nothingRunning) {
    body = (
      <EmptyState
        graphic={<NotRunningGraphic />}
        title="Not running"
        description={`This ${noun} isn't running, so there's nothing to measure. Start it to see live resource usage here.`}
      />
    );
  } else {
    body = (
      <>
        {/* When caps are set, the % gauges read against the cap, not the host. */}
        {hasLimits && (
          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
            <Gauge className="mt-0.5 size-4 shrink-0" />
            <p>
              <span className="font-medium text-foreground">
                Resource limits apply
              </span>{" "}
              - the percentages below are relative to this {noun}&apos;s limits,
              not the whole host&apos;s capacity.{" "}
              {multiContainer
                ? `Each of its ${runningCount} running containers is capped at ${limitParts.join(
                    " · ",
                  )}.`
                : `(${limitParts.join(" · ")})`}
            </p>
          </div>
        )}

        {/* Current-value tiles */}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <GaugeTile
            icon={Cpu}
            label="CPU"
            value={curCpu}
            full={cpuGaugeFull}
            display={cpuDisplay}
            caption={
              cpuLimitAggCores != null
                ? multiContainer
                  ? `of ${fmtCores(cpuLimitAggCores)} (${fmtCores(cpuLimitCores!)} × ${runningCount})`
                  : `of ${fmtCores(cpuLimitAggCores)} limit`
                : cur.hostCores > 0
                  ? `${fmtCores(curCpu / 100)} of ${fmtCores(cur.hostCores)}`
                  : `${cur.running} of ${cur.containers} container${cur.containers === 1 ? "" : "s"} running`
            }
            info={
              cpuLimitAggCores == null && cur.hostCores > 0 ? (
                <p>
                  The arc fills against the whole machine. The chart below plots
                  the same reading the way `docker stats` does, as a percentage
                  of ONE core, so a busy stack there goes past 100%.
                </p>
              ) : undefined
            }
          />
          <GaugeTile
            icon={MemoryStick}
            label="Memory"
            value={curMemPct}
            full={100}
            display={`${curMemPct.toFixed(1)}%`}
            caption={
              memLimitAggMb != null
                ? multiContainer
                  ? `${formatBytes(cur.memUsed)} of ${fmtMemMb(memLimitAggMb)} (${fmtMemMb(memLimitMb!)} × ${runningCount})`
                  : `${formatBytes(cur.memUsed)} of ${fmtMemMb(memLimitAggMb)} limit`
                : memDenom > 0
                  ? `${formatBytes(cur.memUsed)} of ${formatBytes(memDenom)}`
                  : formatBytes(cur.memUsed)
            }
          />
          <Card>
            <CardContent className="space-y-1.5 p-4">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Network className="size-4" />
                <span className="text-xs">Network</span>
              </div>
              <div className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
                <ArrowDown className="size-4 text-[var(--success)]" />
                {formatBytes(curNetRx)}/s
              </div>
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <ArrowUp className="size-4" />
                {formatBytes(curNetTx)}/s
              </div>
            </CardContent>
          </Card>
          {pidsLimitAgg != null ? (
            <GaugeTile
              icon={ListTree}
              label="Processes"
              value={cur.pids}
              full={pidsLimitAgg}
              display={`${cur.pids} / ${pidsLimitAgg}`}
              caption={
                multiContainer
                  ? `PIDs of ${pidsLimit} × ${runningCount}`
                  : "PIDs of the limit"
              }
            />
          ) : (
            // No limit is no ceiling to fill, so the count stays a reading.
            <StatTile
              icon={ListTree}
              label="Processes"
              value={`${cur.pids}`}
              sub="PIDs across the stack"
            />
          )}
        </div>

        {/* Real-time charts */}
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard
            title="CPU usage"
            caption={
              cpuLimitAggCores != null
                ? `${curCpu.toFixed(1)}% of the ${fmtCores(cpuLimitAggCores)} limit`
                : [`${curCpu.toFixed(1)}%`, fmtCoresUsed(curCpu, cur.hostCores)]
                    .filter(Boolean)
                    .join(" · ")
            }
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
              ariaLabel={`CPU usage over time, currently ${curCpu.toFixed(1)}%${
                cpuLimitAggCores != null
                  ? ` of the ${fmtCores(cpuLimitAggCores)} limit`
                  : (fmtCoresUsed(curCpu, cur.hostCores)?.replace(/^/, ", ") ??
                    "")
              }`}
            />
          </ChartCard>

          <ChartCard
            title="Memory usage"
            caption={
              memLimitAggMb != null
                ? `${formatBytes(cur.memUsed)} of ${fmtMemMb(memLimitAggMb)} limit · ${curMemPct.toFixed(1)}%`
                : memDenom > 0
                  ? `${formatBytes(cur.memUsed)} of ${formatBytes(memDenom)} · ${curMemPct.toFixed(1)}%`
                  : formatBytes(cur.memUsed)
            }
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
              ariaLabel={`Memory usage over time, currently ${curMemPct.toFixed(1)}%${memLimitAggMb != null ? ` of the ${fmtMemMb(memLimitAggMb)} limit` : ""}`}
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

          <ChartCard title="Disk I/O">
            <TimeSeriesChart
              unit="bytesPerSec"
              windowMs={windowMs}
              points={points}
              series={[
                { key: "bread", label: "Read", color: "var(--chart-1)" },
                { key: "bwrite", label: "Write", color: "var(--chart-2)" },
              ]}
              ariaLabel="Block device throughput over time, read and write bytes per second"
            />
          </ChartCard>
        </div>

        {/* Per-container breakdown (multi-container stacks only) */}
        {last && last.instances.length > 1 && (
          <ContainerBreakdown instances={last.instances} />
        )}
      </>
    );
  }

  return (
    <div className="space-y-6">
      {header}
      {body}
    </div>
  );
}

/**
 * The dot and the word beside it. Never colour alone - the word is always there,
 * and an agent too old to report a state says so rather than showing a dot that
 * means nothing. Grey is "stopped", red is only a real failure.
 */
function stateOf(c: InstanceMetrics): { dot: string; label: string } {
  if (c.health === "unhealthy")
    return { dot: "bg-destructive", label: "unhealthy" };
  if (c.health === "starting")
    return { dot: "bg-[var(--warning)]", label: "starting" };
  switch (c.state) {
    case "running":
      // An empty `health` is NO healthcheck, not a passing one - so the word
      // stays "running" and never promises health nothing measured.
      return {
        dot: "bg-[var(--success)]",
        label: c.health === "healthy" ? "healthy" : "running",
      };
    case "restarting":
      return { dot: "bg-[var(--warning)]", label: "restarting" };
    case "dead":
      return { dot: "bg-destructive", label: "dead" };
    case "":
      // An agent too old to send a state. The running flag still arrives.
      return {
        dot: c.running ? "bg-[var(--success)]" : "bg-muted-foreground",
        label: c.running ? "running" : "stopped",
      };
    default:
      return { dot: "bg-muted-foreground", label: c.state };
  }
}

/** A compact per-container table for multi-container (compose) stacks. */
function ContainerBreakdown({ instances }: { instances: InstanceMetrics[] }) {
  return (
    <Card>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Container</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">CPU</th>
                <th className="px-4 py-2 text-right font-medium">Memory</th>
                <th className="px-4 py-2 text-right font-medium">PIDs</th>
                <th className="px-4 py-2 text-right font-medium">Restarts</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((c) => (
                <tr key={c.name} className="border-b last:border-0">
                  <td className="px-4 py-2">
                    <span className="font-mono text-xs">{c.name}</span>
                    {netNoteFor(c, instances) && (
                      <span className="mt-1 block text-xs text-muted-foreground">
                        {netNoteFor(c, instances)}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2 whitespace-nowrap">
                      <span
                        className={cn(
                          "inline-flex size-2 shrink-0 rounded-full",
                          stateOf(c).dot,
                        )}
                      />
                      <span className="text-xs">{stateOf(c).label}</span>
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {c.running ? `${c.cpu.toFixed(1)}%` : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {c.running ? formatBytes(c.memUsed) : "—"}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {c.running ? c.pids : "—"}
                  </td>
                  <td
                    className={cn(
                      "px-4 py-2 text-right tabular-nums",
                      c.restartCount > 0 && "text-[var(--warning)]",
                    )}
                  >
                    {c.restartCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
