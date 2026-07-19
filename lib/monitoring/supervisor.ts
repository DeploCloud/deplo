import "server-only";

import { status as GrpcStatus } from "@grpc/grpc-js";

import { listAllServers } from "../data/servers";
import { markServerSeen } from "../data/servers";
import { recordServerHealth } from "../data/server-health";
import { classifyServerHealth } from "../infra/server-health";
import {
  AgentMetricsStreamUnsupportedError,
  AgentUnreachableError,
  connectMetricsStreamAgent,
  type AgentConnection,
} from "../infra/agent-client";
import { isMetricsSavingEnabled } from "../data/monitoring-settings";
import { measureServerForCollector } from "../data/monitoring";
import {
  aggregateContainerStats,
  toContainerSample,
} from "../data/container-metrics";
import { resolveExpectedAgentVersion } from "../version";
import { isAgentOutdated } from "../version";
import type { ServerMetrics } from "../data/monitoring";
import type { HelloResponse, MetricsSample } from "../agent/gen/agent";
import { recordMetricsSample } from "./history";
import {
  recordContainerInstances,
  recordContainerSample,
} from "./container-history";

/**
 * The metrics STREAM SUPERVISOR — what replaced the polling collector.
 *
 * The old model dialled every server (and every watched app) on a timer, opening
 * and closing a fresh mTLS connection per sample. Its cost scaled with
 * hosts x containers x VIEWERS, which is the one axis a monitoring system must
 * not scale on: watching a thing made watching it more expensive. This holds ONE
 * long-lived `StreamMetrics` per host instead, sampled on the agent's own ticker,
 * and demuxes each frame into the RAM ring buffers. Cost is O(hosts).
 *
 * Kept deliberately from the collector it replaces:
 *  - NO cross-process lease. The buffers are per-process RAM, so in a
 *    horizontally-scaled deploy every instance must keep its own copy warm; a
 *    lease would leave N-1 instances answering history reads with nothing.
 *  - Singleton via `Symbol.for(...)` on globalThis, NOT a module-level flag: Next
 *    compiles separate module graphs and `register()` can import this through
 *    more than one, which would silently double every stream and every DB write.
 *  - It must never block boot and never throw into the instrumentation hook.
 *
 * New, and load-bearing: an explicit SHUTDOWN path. The collector was a pair of
 * `unref()`'d intervals, which are free to leak. Open gRPC streams are not — and
 * dev HMR re-runs `register()` on every edit, so without this a day of local work
 * would accumulate dozens of live streams against the same hosts.
 */

/**
 * The reconnect backoff ceiling. THIS CONSTANT IS AN INPUT TO `GAP_MS` in
 * chart-gaps.ts: the worst spacing between two HEALTHY samples is one cadence
 * plus one full backoff step, and the chart bands "No data" above 1.5x that. Move
 * this and you must move GAP_MS with it — `chart-gaps.test.ts` asserts the
 * relationship so the two cannot drift apart silently.
 */
export const RECONNECT_BACKOFF_CAP_MS = 10_000;

/** The cadence we ASK the agent for. It clamps to [1s, 60s] regardless — a
 *  cadence is a hint, never a way for the control plane to pin a host. */
export const STREAM_INTERVAL_MS = 5_000;

/**
 * How often a healthy stream refreshes `status_checked_at`.
 *
 * MUST STAY UNDER `THROTTLE_MS` (15s) in lib/data/server-health.ts. That coupling
 * is invisible from either file and it is the highest-risk edge in this whole
 * change: the health prober skips its own dial while the row looks fresh, so if
 * this interval ever exceeds the prober's throttle, the prober quietly re-enables
 * its 15s fleet-wide dial fan-out — reintroducing exactly the per-host RPC churn
 * this architecture exists to remove, while the charts still look perfect and
 * nothing tells you. `supervisor.test.ts` asserts BOTH bounds.
 *
 * 8s, NOT 10s, and the difference is not cosmetic — it is an ALIASING guard, and
 * 10s was measured failing in production.
 *
 * The heartbeat can only fire when a frame arrives, so its real period is a
 * MULTIPLE of the cadence. At 10s with a 5s cadence the second frame lands on the
 * boundary, and a frame even one millisecond early (4999ms of elapsed, twice, is
 * 9998) fails `>= 10_000` and defers the write to the THIRD frame — a real period
 * of 15s, exactly THROTTLE_MS, right where the prober starts re-dialing. Observed
 * on the live fleet: writes at 14:22:49, 14:23:04, 14:23:19.
 *
 * Anything strictly between one and two cadences makes the second frame fire
 * regardless of jitter, giving a stable 10s period with 5s of headroom under the
 * throttle. Keep this INSIDE (cadence, 2 x cadence) if either constant moves.
 */
export const HEALTH_WRITE_MS = 8_000;

/** How often to pick up newly-registered / removed servers. */
const RECONCILE_MS = 30_000;

/** Cadence of the legacy poll used for agents without the capability. */
const POLL_FALLBACK_MS = 5_000;

/**
 * EMERGENCY KILL SWITCH. Set `DEPLO_MONITORING_FORCE_POLL=1` and restart the
 * control plane to force every server onto the legacy poll path, with no agent
 * touched and nothing rolled back.
 *
 * This exists because the agent binary is FORWARD-ONLY: `resolveLatestAgentRelease`
 * is always-latest, so `updateServerAgent` structurally cannot downgrade. That
 * makes this — not a binary rollback — the real revert for the streaming path, and
 * it must therefore be in place BEFORE the first canary. The path it falls back to
 * is the code that runs in production today.
 */
function forcePollMode(): boolean {
  return process.env.DEPLO_MONITORING_FORCE_POLL === "1";
}

type StreamMode = "stream" | "poll";

/**
 * How a per-server loop obtains its stream. The ONE seam this module exposes for
 * tests: everything else here (demux, backoff, the health heartbeat) is pure or
 * hits the DB, both of which a pglite test can drive directly — but the agent
 * dial cannot be exercised without a socket, and it is the input every branch
 * worth pinning hangs off. Injecting the connector keeps the supervisor's own
 * control flow under test instead of mocked away.
 */
type MetricsConnector = typeof connectMetricsStreamAgent;

let connector: MetricsConnector = connectMetricsStreamAgent;

/** Test-only: swap the agent dial. Pass nothing to restore the real one. */
export function __setMetricsConnectorForTest(fn?: MetricsConnector): void {
  connector = fn ?? connectMetricsStreamAgent;
}

interface ServerStream {
  mode: StreamMode;
  /** Aborts the per-server loop; resolves when it has actually stopped. */
  abort: AbortController;
  /** The running loop, so shutdown can await a clean stop. */
  loop: Promise<void>;
}

interface SupervisorState {
  started: boolean;
  timer: ReturnType<typeof setInterval> | null;
  servers: Map<string, ServerStream>;
  stopping: boolean;
}

const STATE_KEY = Symbol.for("deplo.monitoring.streams");
const g = globalThis as unknown as { [STATE_KEY]?: SupervisorState };
const state: SupervisorState = (g[STATE_KEY] ??= {
  started: false,
  timer: null,
  servers: new Map(),
  stopping: false,
});

/* ------------------------------------------------------------------ */
/* Frame handling                                                      */
/* ------------------------------------------------------------------ */

/** What the opening Hello told us, reused for every frame on that connection so
 *  a 5s frame does not cost a Hello round-trip to label itself. */
interface ConnectionFacts {
  agentVersion: string | null;
  traefik: boolean;
  expectedAgentVersion: string;
}

/** Map one wire frame's host half onto the ServerMetrics the buffer + charts use.
 *  `ts` is stamped HERE, on receipt, not from the frame's `sampledAtUnixMs`:
 *  clock skew between hosts must never move a point on a chart. The agent's own
 *  timestamp rides along in the frame purely so a sampling gap stays diagnosable. */
function hostSampleFrom(
  serverId: string,
  frame: MetricsSample,
  facts: ConnectionFacts,
): ServerMetrics | null {
  const h = frame.host;
  if (!h) return null;
  return {
    serverId,
    online: true,
    traefik: facts.traefik,
    cpu: h.cpu,
    cpuCores: h.cpuCores,
    memUsed: Number(h.memUsed),
    memTotal: Number(h.memTotal),
    memPct: h.memPct,
    diskUsed: Number(h.diskUsed),
    diskTotal: Number(h.diskTotal),
    diskPct: h.diskPct,
    netRx: Number(h.netRx),
    netTx: Number(h.netTx),
    load: [h.load1, h.load5, h.load15],
    uptimeSec: Number(h.uptimeSec),
    containers: h.runningContainers,
    agentVersion: facts.agentVersion,
    expectedAgentVersion: facts.expectedAgentVersion,
    agentOutdated: isAgentOutdated(facts.agentVersion, facts.expectedAgentVersion),
    ts: Date.now(),
  };
}

/**
 * Demux one frame into the ring buffers.
 *
 * Host history stays gated on the instance-wide "save metrics" switch, matching
 * what every writer did before. Container history is deliberately NOT gated, also
 * matching today — and the filter is applied HERE, on the record side, never by
 * declining to open the stream: one stream carries both halves, so gating the
 * transport would take container history down as collateral.
 */
async function ingestFrame(
  serverId: string,
  frame: MetricsSample,
  facts: ConnectionFacts,
): Promise<void> {
  const host = hostSampleFrom(serverId, frame, facts);
  if (host && (await isMetricsSavingEnabled())) recordMetricsSample(host);

  // Group this host's containers by the App / Database they belong to. The
  // `deplo.project` label is the demux key and it is the ONLY identity we trust —
  // an unlabelled container is not ours to attribute, so it is skipped rather
  // than guessed at from its name.
  const byProject = new Map<string, typeof frame.containers>();
  for (const c of frame.containers) {
    if (!c.projectId) continue;
    const bucket = byProject.get(c.projectId);
    if (bucket) bucket.push(c);
    else byProject.set(c.projectId, [c]);
  }
  const ts = Date.now();
  for (const [projectId, stats] of byProject) {
    const agg = aggregateContainerStats(projectId, stats, ts);
    // The breakdown replaces its cell; the aggregate appends to the window. Two
    // different lifetimes on purpose — see recordContainerInstances.
    recordContainerInstances(projectId, agg.instances);
    recordContainerSample(toContainerSample(agg));
  }
}

/* ------------------------------------------------------------------ */
/* Per-server loop                                                     */
/* ------------------------------------------------------------------ */

/** Capped exponential backoff with +/-20% jitter, so a fleet that lost its
 *  network does not reconnect in lockstep and thundering-herd the hosts.
 *  Exported for `supervisor.test.ts`, which pins the growth AND the ceiling —
 *  an uncapped step is how a host that came back stays dark for an hour. */
export function backoffFor(attempt: number): number {
  const base = Math.min(RECONNECT_BACKOFF_CAP_MS, 1_000 * 2 ** attempt);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * Hold one server's telemetry stream for as long as the supervisor runs.
 *
 * Reconnect attempts are UNBOUNDED by design: a host down for an hour must come
 * back on its own when it returns, with no operator action. Nothing is ever
 * replayed — unlike a deploy event, a metrics sample missed is a sample with no
 * remaining value, and the honest rendering of the gap is a gap.
 */
async function runStreamLoop(serverId: string, signal: AbortSignal): Promise<void> {
  let attempt = 0;

  while (!signal.aborted && !state.stopping) {
    let conn: AgentConnection | null = null;
    try {
      const opened = await connector(serverId);
      conn = opened.conn;
      const hello: HelloResponse = opened.hello;
      attempt = 0;

      const facts: ConnectionFacts = {
        agentVersion: hello.agentVersion || null,
        traefik: hello.traefikRunning,
        expectedAgentVersion: await resolveExpectedAgentVersion(),
      };

      // On OPEN: persist what the Hello told us, and record health. This Hello is
      // a health observation as good as the prober's own, and — unlike the old
      // metrics poll, which issued metrics() first — a certificate rejection here
      // arrives WITH the `trust` flag, so an untrusted agent is recorded as the
      // security-relevant `error` instead of a benign `offline`.
      await markServerSeen(
        serverId,
        hello.agentVersion,
        hello.traefikRunning,
        undefined,
        hello.dockerVersion,
      );
      let lastHealthWriteAt = Date.now();
      await recordServerHealth(serverId, classifyServerHealth(hello, null), new Date().toISOString());

      for await (const frame of conn.streamMetrics({
        dataDir: "",
        intervalMs: STREAM_INTERVAL_MS,
        includeContainers: true,
      })) {
        if (signal.aborted || state.stopping) break;

        await ingestFrame(serverId, frame, facts);

        // Health heartbeat, throttled — see HEALTH_WRITE_MS. A received frame IS
        // proof of reachability, so this replaces a dial rather than adding one.
        const now = Date.now();
        if (now - lastHealthWriteAt >= HEALTH_WRITE_MS) {
          lastHealthWriteAt = now;
          await recordServerHealth(
            serverId,
            { status: "online", message: null },
            new Date(now).toISOString(),
          );
        }
      }

      // A clean end is the deadline rotation (or a shutdown). Reconnect at once:
      // no backoff, no health write, ~100ms of gap — two orders of magnitude
      // under GAP_MS, so it never draws a band.
    } catch (e) {
      if (e instanceof AgentMetricsStreamUnsupportedError) {
        // Not a failure — this one server's agent predates the stream. Demote it
        // alone and keep the rest of the fleet streaming.
        conn?.close();
        await runPollLoop(serverId, signal);
        return;
      }

      const rotation =
        e instanceof AgentUnreachableError && e.code === GrpcStatus.DEADLINE_EXCEEDED;

      if (!rotation) {
        // A real failure. Record it once, then back off. Deliberately do NOT
        // record health on every retry — a host down for an hour would otherwise
        // write once per backoff step forever.
        if (attempt === 0) {
          await recordServerHealth(
            serverId,
            classifyServerHealth(null, e),
            new Date().toISOString(),
          ).catch(() => {});
        }
        const delay = backoffFor(attempt);
        attempt = Math.min(attempt + 1, 16);
        await sleep(delay, signal);
      }
    } finally {
      conn?.close();
    }
  }
}

/**
 * The degradation path, kept PERMANENTLY rather than only through the rollout: a
 * fleet is updated server by server, and nothing stops someone registering a
 * server running last year's agent tomorrow.
 *
 * HOST METRICS ONLY, deliberately. The old collector also polled per-container
 * stats, but it could only do so because it had a LIST of which resources to
 * sample — the `save_metrics` columns plus a watch TTL — and that list is exactly
 * what the stream made obsolete and this change deleted. Rebuilding an
 * enumeration here purely to serve outdated agents would resurrect the cost model
 * (one RPC per resource per tick) we removed, on the hosts least able to afford
 * it, to populate a tab the user can fix by clicking "Update agent".
 *
 * So on a pre-stream agent the fleet charts keep working and the per-App tab
 * shows its existing "update the agent on this server" state — the same state it
 * already shows for an agent lacking `container-stats`. That is honest, costs
 * nothing, and points at the fix.
 */
async function runPollLoop(serverId: string, signal: AbortSignal): Promise<void> {
  const entry = state.servers.get(serverId);
  if (entry) entry.mode = "poll";

  while (!signal.aborted && !state.stopping) {
    try {
      if (await isMetricsSavingEnabled()) {
        const servers = await listAllServers();
        const server = servers.find((s) => s.id === serverId);
        if (!server) return;
        const expected = await resolveExpectedAgentVersion();
        recordMetricsSample(await measureServerForCollector(server, expected));
      }
    } catch {
      // An unreachable host degrades to an offline snapshot the buffer refuses,
      // leaving the honest gap. Never fatal to the loop.
    }
    await sleep(POLL_FALLBACK_MS, signal);
  }
}

/* ------------------------------------------------------------------ */
/* Reconcile + lifecycle                                               */
/* ------------------------------------------------------------------ */

/** Start a loop for every provisioned server, stop loops for servers that went
 *  away. Idempotent — safe to call on a timer. */
export async function reconcileMetricsStreams(): Promise<void> {
  if (state.stopping) return;
  let servers: Awaited<ReturnType<typeof listAllServers>>;
  try {
    servers = await listAllServers();
  } catch {
    return; // DB blip; the next tick reconciles.
  }

  const live = new Set<string>();
  for (const s of servers) {
    // No agent enrolled yet (still provisioning, or never called home): there is
    // nothing to dial, and pretending otherwise would write a false offline.
    if (!s.agent?.certFingerprint) continue;
    live.add(s.id);
    if (state.servers.has(s.id)) continue;

    const abort = new AbortController();
    const mode: StreamMode = forcePollMode() ? "poll" : "stream";
    const entry: ServerStream = { mode, abort, loop: Promise.resolve() };
    state.servers.set(s.id, entry);
    entry.loop = (mode === "poll"
      ? runPollLoop(s.id, abort.signal)
      : runStreamLoop(s.id, abort.signal)
    ).catch((e) => {
      console.warn(
        `[monitoring] stream loop for ${s.name} exited: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  for (const [id, entry] of state.servers) {
    if (live.has(id)) continue;
    entry.abort.abort();
    state.servers.delete(id);
  }
}

/** Start the supervisor. Idempotent; never throws into the caller. */
export function startMetricsStreams(): void {
  if (state.started) return;
  state.started = true;
  state.stopping = false;

  if (forcePollMode()) {
    console.warn(
      "[deplo] DEPLO_MONITORING_FORCE_POLL=1 — telemetry streams disabled, polling every server",
    );
  }

  const timer = setInterval(() => {
    void reconcileMetricsStreams();
  }, RECONCILE_MS);
  if (typeof timer.unref === "function") timer.unref();
  state.timer = timer;

  void reconcileMetricsStreams();
  console.log("[deplo] metrics stream supervisor started");
}

/**
 * Stop every stream and wait for the loops to unwind.
 *
 * Unlike the interval-based collector this is NOT optional: each live stream
 * holds an open gRPC channel on this side and a ticker plus a `docker events`
 * child on the agent's. Leaving them dangling leaks on both ends of the wire.
 */
export async function stopMetricsStreams(): Promise<void> {
  state.stopping = true;
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
  const loops = [...state.servers.values()].map((e) => {
    e.abort.abort();
    return e.loop;
  });
  state.servers.clear();
  state.started = false;
  await Promise.allSettled(loops);
}

/** Test-only: the current per-server modes. */
export function __streamModes(): Record<string, StreamMode> {
  const out: Record<string, StreamMode> = {};
  for (const [id, e] of state.servers) out[id] = e.mode;
  return out;
}
