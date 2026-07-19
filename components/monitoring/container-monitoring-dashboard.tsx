"use client";

import * as React from "react";
import {
  Cpu,
  MemoryStick,
  Network,
  Boxes,
  ListTree,
  ServerOff,
  ArrowDown,
  ArrowUp,
  ArrowUpCircle,
  Gauge,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { TimeSeriesChart } from "@/components/monitoring/time-series-chart";
import {
  StatTile,
  ChartCard,
  WindowSelector,
  LiveStatusLine,
  WINDOWS,
  POLL_MS,
  MAX_POINTS,
  STALE_AFTER_MS,
} from "@/components/monitoring/dashboard-parts";
import { gqlAction } from "@/lib/graphql-client";
import { formatBytes } from "@/lib/utils";
import type { ResourceLimits } from "@/lib/types";

/** "0.5 core" / "1 core" / "2 cores" from a fractional core count. */
function fmtCores(cores: number): string {
  const s = Number.isInteger(cores) ? String(cores) : String(Number(cores.toFixed(3)));
  return `${s} core${cores === 1 ? "" : "s"}`;
}

/** A configured memory cap, in the SAME "MB (1024 = 1 GB)" convention as
 *  Settings → Resources — so the label matches what the operator typed
 *  ("512 MB", "2 GB"), not pretty-bytes' decimal rendering ("537 MB"). */
function fmtMemMb(mb: number): string {
  return mb >= 1024 ? `${Number((mb / 1024).toFixed(2))} GB` : `${mb} MB`;
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
}
interface ContainerLive extends ContainerSample {
  unsupported: boolean;
  instances: InstanceMetrics[];
}

const SAMPLE_FIELDS = `online ts cpu memUsed memLimit memPct netRx netTx blockRead blockWrite pids running containers`;
const LIVE_FIELDS = `${SAMPLE_FIELDS} unsupported instances { name running cpu memUsed memLimit memPct netRx netTx blockRead blockWrite pids }`;

/** Per-second rate from two cumulative-counter samples; a counter reset
 *  (container restart, so the total dropped) clamps to 0 rather than a spike. */
function rate(cur: number, prev: number, dtSec: number): number {
  if (dtSec <= 0) return 0;
  return Math.max(0, (cur - prev) / dtSec);
}

/**
 * The per-app / per-database Monitoring tab. Mirrors the fleet Monitoring page,
 * but scoped to ONE stack's containers.
 *
 * NOTHING HERE MAKES A HOST MEASURE. Every read below is a read of the control
 * plane's in-RAM ring buffer, which the telemetry-stream supervisor fills from a
 * single long-lived stream per host carrying every Deplo-managed container. That
 * is why this tab no longer owns a "Save metrics" switch: the stream carries this
 * stack whether or not anyone opted in, so the toggle's only remaining effect
 * would have been declining ~23KB of RAM while its tooltip described a per-sample
 * agent cost that no longer exists. The instance-wide switch on the fleet
 * Monitoring page remains the master control.
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
   *  cap (not the whole host) — null when uncapped. */
  resources: ResourceLimits | null;
}) {
  const noun = kind === "app" ? "app" : "database";
  const metricsField = kind === "app" ? "appMetrics" : "databaseMetrics";
  const historyField = kind === "app" ? "appMetricsHistory" : "databaseMetricsHistory";
  const idArg = kind === "app" ? "appId" : "databaseId";

  // Configured PER-CONTAINER caps. deplo applies the app-level resource limits to
  // EVERY container in the stack (see mergeResourceLimits), so a stack's aggregate
  // budget is the cap × its running-container count. The app-total usage we chart
  // is SUMMED across those same containers, so the "% of limit" gauges must divide
  // by that aggregate — dividing the summed usage by a SINGLE container's cap
  // over-reports by ~the container count (a 3-service stack pegged at its caps
  // would read ~300%, not ~100%). docker's memory % is already relative to the
  // applied mem_limit, but CPU % is host-relative (100% = one core), so both are
  // rescaled here against the CONFIGURED cap × running: the gauges match the note
  // and still read honestly >100% when a cap isn't applied yet (pre-redeploy).
  const cpuLimitCores = resources?.cpuMilli != null ? resources.cpuMilli / 1000 : null;
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
  // The live-vs-history split is kept, but both halves now come from the same
  // buffer: `samples` is the SERIES the charts draw, `last` is the latest-value
  // CELL — the per-container breakdown and the `unsupported` flag, which are a
  // live table rather than a series and so are not carried in every point.
  // Splitting them also lets the header say "not answering" while the charts
  // keep the honest gap instead of drawing a fake zero.
  const [samples, setSamples] = React.useState<ContainerSample[]>(() =>
    initialHistory.filter((s) => s.online),
  );
  const [last, setLast] = React.useState<ContainerLive | null>(null);
  // A render clock, advanced by the read loop below. Without it, "live" would be
  // decided by whatever timestamp the last SUCCESSFUL read returned: if reads
  // start failing, or the stream stops delivering, nothing re-renders and the
  // header keeps claiming live against a frozen chart. Ticking it on every
  // attempt is what lets staleness assert itself.
  const [now, setNow] = React.useState<number>(() => Date.now());

  // ONE read, on POLL_MS, for both halves.
  //
  // What this replaced: a 1s "live" poll that each tick made the owning host
  // measure, appending its answer as the chart's primary feed, with a slower
  // history re-merge bolted on beside it to repair the holes the append-only
  // feed inevitably left. Under the stream the append-only feed is gone: the
  // MERGE is the feed. Every point the charts draw comes from the server-side
  // buffer, so a missed request, a slow tab, or a stretch when nobody was
  // looking simply resolves on the next read instead of scarring the window
  // permanently — the repair pass and the thing it repaired are now one path.
  //
  // Both fields ride ONE document deliberately. They are two reads of the same
  // in-RAM buffer; splitting them into two timers would double the request rate
  // for no extra freshness and let the tiles and the charts land a beat apart.
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
        // Keep every recorded measurement, `running: 0` included. The buffer
        // only ever holds online samples, and filtering the idle ones back out
        // here is what once made a redeploy read as a hole: a stopped stack
        // genuinely measures zero, and zero is a measurement.
        const fresh = res.data.history.filter((s) => s.online);
        setSamples((prev) => {
          const byTs = new Map<number, ContainerSample>();
          // Buffer samples second so they win a timestamp collision — same
          // data, authoritative provenance.
          for (const s of [...prev, ...fresh]) byTs.set(s.ts, s);
          const merged = [...byTs.values()]
            .sort((a, b) => a.ts - b.ts)
            .slice(-MAX_POINTS);
          // Reads run faster than the agent's cadence, so most of them return a
          // window identical to the one already on screen. Keep the previous
          // ARRAY in that case: a fresh identity would invalidate the points
          // memo and redraw every chart several times per new measurement.
          const head = merged[merged.length - 1];
          const prevHead = prev[prev.length - 1];
          if (
            merged.length === prev.length &&
            head?.ts === prevHead?.ts
          ) {
            return prev;
          }
          return merged;
        });
      } finally {
        busy = false;
      }
    };

    void read();
    const iv = setInterval(read, POLL_MS);
    // Read on wake as well as on the timer. A backgrounded tab has its timers
    // clamped to roughly 1/min, which is PRECISELY the case server-side
    // buffering exists to cover: the frames kept arriving while the tab slept,
    // so an immediate read on return paints the whole continuous window at once
    // instead of showing a false hole that fills in over the next minute. A
    // soft-nav back or a bfcache restore may not remount this component, so a
    // mount-only read would never re-run — `pageshow` covers the bfcache case.
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
  }, [id, metricsField, historyField, idArg]);

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
            // CPU/mem rescaled to the aggregate caps (per-container cap × that
            // sample's running count) so the charts' 0-100% axis means "% of the
            // limit" when one is set (inlined from cpuOf/memPctOf so the memo
            // depends only on the primitive caps).
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
  const cpuLimitAggCores = cpuLimitCores != null ? cpuLimitCores * capMult : null;
  const memLimitAggMb = memLimitMb != null ? memLimitMb * capMult : null;
  const pidsLimitAgg = pidsLimit != null ? pidsLimit * capMult : null;
  // Memory denominator to display when uncapped: docker's memLimit (the host
  // total). When capped, the aggregate cap above is used instead.
  const memDenom = cur?.memLimit ?? 0;
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
  // Judge it by how old the newest measurement is, at the same threshold the
  // charts band "No data" at, so the header and the chart cannot contradict.
  const stale =
    Boolean(last && !last.online) ||
    (cur ? now - cur.ts > STALE_AFTER_MS : false);

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      {cur ? (
        <LiveStatusLine stale={stale} asOf={cur.ts} />
      ) : (
        <span className="text-xs text-muted-foreground">Live container metrics</span>
      )}
      {cur && <WindowSelector windowMs={windowMs} onChange={setWindowMs} />}
    </div>
  );

  // Empty states, in priority order.
  let body: React.ReactNode;
  if (last?.unsupported) {
    body = (
      <EmptyCard
        icon={ArrowUpCircle}
        title="Update the agent"
        text={`The agent on this ${noun}'s server is too old to report per-container metrics. Update the agent on that server (Servers → the server → update) to enable this tab.`}
      />
    );
  } else if (!cur) {
    if (last && !last.online) {
      // "Offline" now means the control plane holds NO frame for this stack.
      // Under the stream that has two causes it cannot tell apart from here —
      // the host isn't reachable, or its server agent is too old to stream and
      // the supervisor fell back to host-only telemetry. So the copy stays
      // neutral about the cause and points at the one page that shows both
      // (Servers carries the reachability state and the update button).
      body = (
        <EmptyCard
          icon={ServerOff}
          title="No metrics yet"
          text={`Nothing has arrived for this ${noun}. Metrics appear as soon as its server starts reporting — check that server on the Servers page if this persists.`}
        />
      );
    } else if (last && last.running === 0) {
      body = (
        <EmptyCard
          icon={ServerOff}
          title="Not running"
          text={`This ${noun} isn't running, so there's nothing to measure. Start it to see live resource usage here.`}
        />
      );
    } else {
      body = (
        <EmptyCard
          icon={Boxes}
          title="Collecting…"
          text="Waiting for the first measurement to arrive from this server."
        />
      );
    }
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
              — the percentages below are relative to this {noun}&apos;s limits,
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
          <StatTile
            icon={Cpu}
            label="CPU"
            value={`${curCpu.toFixed(1)}%`}
            sub={
              cpuLimitAggCores != null
                ? multiContainer
                  ? `of ${fmtCores(cpuLimitAggCores)} (${fmtCores(cpuLimitCores!)} × ${runningCount})`
                  : `of ${fmtCores(cpuLimitAggCores)} limit`
                : `${cur.running} of ${cur.containers} container${cur.containers === 1 ? "" : "s"} running`
            }
            pct={curCpu}
          />
          <StatTile
            icon={MemoryStick}
            label="Memory"
            value={`${curMemPct.toFixed(1)}%`}
            sub={
              memLimitAggMb != null
                ? multiContainer
                  ? `${formatBytes(cur.memUsed)} of ${fmtMemMb(memLimitAggMb)} (${fmtMemMb(memLimitMb!)} × ${runningCount})`
                  : `${formatBytes(cur.memUsed)} of ${fmtMemMb(memLimitAggMb)} limit`
                : memDenom > 0
                  ? `${formatBytes(cur.memUsed)} / ${formatBytes(memDenom)}`
                  : formatBytes(cur.memUsed)
            }
            pct={curMemPct}
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
          <StatTile
            icon={ListTree}
            label="Processes"
            value={pidsLimitAgg != null ? `${cur.pids} / ${pidsLimitAgg}` : `${cur.pids}`}
            sub={
              pidsLimitAgg != null
                ? multiContainer
                  ? `PIDs of ${pidsLimit} × ${runningCount}`
                  : "PIDs of the limit"
                : "PIDs across the stack"
            }
          />
        </div>

        {/* Real-time charts */}
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartCard
            title="CPU usage"
            caption={
              cpuLimitAggCores != null
                ? `${curCpu.toFixed(1)}% of the ${fmtCores(cpuLimitAggCores)} limit`
                : `${curCpu.toFixed(1)}%`
            }
          >
            <TimeSeriesChart
              unit="percent"
              windowMs={windowMs}
              points={points}
              series={[{ key: "cpu", label: "CPU", color: "var(--chart-1)", fill: true }]}
              ariaLabel={`CPU usage over time, currently ${curCpu.toFixed(1)}%${cpuLimitAggCores != null ? ` of the ${fmtCores(cpuLimitAggCores)} limit` : ""}`}
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
              series={[{ key: "mem", label: "Memory", color: "var(--chart-1)", fill: true }]}
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

function EmptyCard({
  icon: Icon,
  title,
  text,
}: {
  icon: typeof ServerOff;
  title: string;
  text: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-2 py-16 text-center">
        <Icon className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-sm text-xs text-muted-foreground">{text}</p>
      </CardContent>
    </Card>
  );
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
                <th className="px-4 py-2 text-right font-medium">CPU</th>
                <th className="px-4 py-2 text-right font-medium">Memory</th>
                <th className="px-4 py-2 text-right font-medium">PIDs</th>
              </tr>
            </thead>
            <tbody>
              {instances.map((c) => (
                <tr key={c.name} className="border-b last:border-0">
                  <td className="px-4 py-2">
                    <span className="flex items-center gap-2">
                      <span
                        className={
                          c.running
                            ? "inline-flex size-2 rounded-full bg-[var(--success)]"
                            : "inline-flex size-2 rounded-full bg-muted-foreground/40"
                        }
                      />
                      <span className="font-mono text-xs">{c.name}</span>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
