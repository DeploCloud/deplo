// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import "server-only";

// https://deplo.build/docs/guides/observability/monitoring

import { status as GrpcStatus } from "@grpc/grpc-js";

import { listAllServers } from "../data/servers";
import { markServerSeen, observedTraefik } from "../data/servers";
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
import { getDb } from "../db/client";
import {
  apps as appsTable,
  databases as databasesTable,
} from "../db/schema/control-plane";
import {
  aggregateContainerStats,
  toContainerSample,
} from "../data/container-metrics";
import { reconcileAppStatusFromTelemetry } from "../data/app-status-reconcile";
import { resolveExpectedAgentVersion } from "../version";
import type { ServerMetrics } from "../data/monitoring";
import type {
  ContainerStat,
  HelloResponse,
  MetricsSample,
} from "../agent/gen/agent";
import { checkResourceThresholds } from "../notify/thresholds";
import { pruneMetricsHistoryTo, recordMetricsSample } from "./history";
import {
  clearMetricsStreamUnsupported,
  markMetricsStreamUnsupported,
} from "./stream-modes";
import {
  pruneContainerHistoryTo,
  recordContainerInstances,
  recordContainerSample,
} from "./container-history";

/**
 * The metrics STREAM SUPERVISOR - what replaced the polling collector. Its cost
 * scaled with hosts x containers x VIEWERS, which is the one axis a monitoring
 * system must not scale on: watching a thing made watching it more expensive.
 */

/**
 * The reconnect backoff ceiling. Move this and you must move GAP_MS with it -
 * `chart-gaps.test.ts` asserts the relationship so the two cannot drift apart
 * silently.
 */
export const RECONNECT_BACKOFF_CAP_MS = 10_000;

/** The cadence we ASK the agent for. It clamps to [1s, 60s] regardless - a
 *  cadence is a hint, never a way for the control plane to pin a host. */
export const STREAM_INTERVAL_MS = 5_000;

/**
 * The lifetime under which a stream did not really RUN.
 */
const MIN_STREAM_MS = STREAM_INTERVAL_MS;

/**
 * How often a healthy stream refreshes `status_checked_at`. MUST STAY UNDER
 * `THROTTLE_MS` (15s) in lib/data/server-health.ts.
 */
export const HEALTH_WRITE_MS = 8_000;

/**
 * How often a healthy stream re-checks its Apps' STORED status against what the
 * host is actually reporting - the consumer for the per-container `state` the
 * frame has been carrying unread.
 */
export const APP_STATUS_RECONCILE_MS = 30_000;

/** How often to pick up newly-registered / removed servers. Unrelated to
 *  {@link APP_STATUS_RECONCILE_MS} despite the shared value - this one paces the
 *  SERVER-list reconcile (`reconcileMetricsStreams`), not any per-App write. */
const RECONCILE_MS = 30_000;

/** Cadence of the legacy poll used for agents without the capability. */
const POLL_FALLBACK_MS = 5_000;

/**
 * EMERGENCY KILL SWITCH. This exists because the agent binary is FORWARD-ONLY:
 * `resolveLatestAgentRelease` is always-latest, so `updateServerAgent`
 * structurally cannot downgrade.
 */
function forcePollMode(): boolean {
  return process.env.DEPLO_MONITORING_FORCE_POLL === "1";
}

type StreamMode = "stream" | "poll";

/**
 * How a per-server loop obtains its stream.
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
  /** Carried so a threshold alert can name the host, not its id. */
  serverName: string;
}

/**
 * Map one wire frame's host half onto the ServerMetrics the buffer + charts use.
 * `ts` is stamped HERE, on receipt, not from the frame's `sampledAtUnixMs`: clock
 * skew between hosts must never move a point on a chart.
 */
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
    memFree: Number(h.memFree),
    memCache: Number(h.memCache),
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
    // Which sampler produced this frame, so "this host is on the slow path" is
    // visible without a second RPC. Empty from an agent too old to label it.
    source: frame.source,
    ts: Date.now(),
  };
}

/**
 * Demux one frame into the ring buffers. Host history stays gated on the
 * instance-wide "save metrics" switch, matching what every writer did before.
 */
async function ingestFrame(
  serverId: string,
  frame: MetricsSample,
  facts: ConnectionFacts,
): Promise<Map<string, ContainerStat[]>> {
  const host = hostSampleFrom(serverId, frame, facts);
  // ABOVE the save-metrics gate, deliberately: that switch means "keep 16 minutes
  // of chart history in RAM", and turning charts off must never turn ALERTING
  // off. Free in the steady state - a Map lookup per metric, no query.
  if (host)
    checkResourceThresholds(serverId, facts.serverName || serverId, host);
  if (host && (await isMetricsSavingEnabled())) recordMetricsSample(host);

  // Group this host's containers by the App / Database they belong to.
  const byProject = new Map<string, ContainerStat[]>();
  for (const c of frame.containers) {
    if (!c.projectId) continue;
    const bucket = byProject.get(c.projectId);
    if (bucket) bucket.push(c);
    else byProject.set(c.projectId, [c]);
  }
  const ts = Date.now();
  // The machine is every stack's ceiling - see aggregateContainerStats.
  const capacity = {
    memTotal: host?.memTotal ?? 0,
    cpuCores: host?.cpuCores ?? 0,
  };
  for (const [projectId, stats] of byProject) {
    const agg = aggregateContainerStats(projectId, stats, ts, capacity);
    // The breakdown replaces its cell; the aggregate appends to the window. Two
    // different lifetimes on purpose - see recordContainerInstances.
    recordContainerInstances(projectId, agg.instances);
    recordContainerSample(toContainerSample(agg));
  }
  return byProject;
}

/* ------------------------------------------------------------------ */
/* Per-server loop                                                     */
/* ------------------------------------------------------------------ */

/**
 * Capped exponential backoff with +/-20% jitter, so a fleet that lost its network
 * does not reconnect in lockstep and thundering-herd the hosts.
 */
export function backoffFor(attempt: number): number {
  const base = Math.min(RECONNECT_BACKOFF_CAP_MS, 1_000 * 2 ** attempt);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Hold one server's telemetry stream for as long as the supervisor runs. Reconnect
 * attempts are UNBOUNDED by design: a host down for an hour must come back on its
 * own when it returns, with no operator action.
 */
async function runStreamLoop(
  serverId: string,
  serverName: string,
  /** A storage-only host has no Docker on purpose, so its heartbeat must not
   *  keep re-asserting `warning` for a correct configuration. */
  storageOnly: boolean,
  signal: AbortSignal,
): Promise<void> {
  let attempt = 0;

  while (!signal.aborted && !state.stopping) {
    let conn: AgentConnection | null = null;
    // Stamped once the dial succeeds; null means the failure was AT connect.
    // Stream LIFETIME against MIN_STREAM_MS is the classifier for every end
    // path below - status codes alone cannot tell a rotation from an outage.
    let openedAt: number | null = null;
    // `streamMetrics` takes no AbortSignal (the RPC deadline is the agent contract's
    // only cancel), so the abort is wired to the CHANNEL instead: closing it ends the
    // frame iterator promptly, rather than the loop only noticing the abort at the next
    const onAbort = () => conn?.close();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const opened = await connector(serverId);
      conn = opened.conn;
      const hello: HelloResponse = opened.hello;
      openedAt = Date.now();
      // The stream opened, so the agent is new enough - clears a demotion an
      // earlier attempt recorded, which is what makes the tab's "update the
      // agent" state disappear on its own after a fleet update.
      clearMetricsStreamUnsupported(serverId);

      const facts: ConnectionFacts = {
        agentVersion: hello.agentVersion || null,
        traefik: hello.traefikRunning,
        expectedAgentVersion: await resolveExpectedAgentVersion(),
        serverName,
      };

      // The honest health of this connection, computed ONCE from the Hello and reused by
      // every heartbeat below.
      const connHealth = classifyServerHealth(hello, null, { storageOnly });

      // On OPEN: persist what the Hello told us, and record health.
      await markServerSeen(
        serverId,
        hello.agentVersion,
        observedTraefik(hello),
        undefined,
        hello.dockerVersion,
        hello.hostArch,
      );
      let lastHealthWriteAt = Date.now();
      // 0, not `Date.now()`: the first frame after a (re)connect must reconcile App
      // statuses immediately.
      let lastStatusReconcileAt = 0;
      await recordServerHealth(serverId, connHealth, new Date().toISOString());

      for await (const frame of conn.streamMetrics({
        dataDir: "",
        intervalMs: STREAM_INTERVAL_MS,
        includeContainers: true,
      })) {
        if (signal.aborted || state.stopping) break;
        // A received frame is the proof the stream is genuinely up - only now
        // does the reconnect backoff reset. Resetting at connect let a stream
        // that dies straight after the dial zero it and re-dial hot forever.
        attempt = 0;

        const byProject = await ingestFrame(serverId, frame, facts);

        // Health heartbeat, throttled - see HEALTH_WRITE_MS. A received frame IS
        // proof of reachability, so this replaces a dial rather than adding one.
        const now = Date.now();
        if (now - lastHealthWriteAt >= HEALTH_WRITE_MS) {
          lastHealthWriteAt = now;
          await recordServerHealth(
            serverId,
            connHealth,
            new Date(now).toISOString(),
          );
          // Every frame carries the host's CAPACITY, and nothing else refreshes it
          // any more: the Servers page kept showing the size the machine was when
          // it was first measured, so a resized VPS never grew there.
          const cap = frame.host;
          if (cap && cap.cpuCores > 0) {
            await markServerSeen(serverId, undefined, undefined, {
              cpuCores: cap.cpuCores,
              memoryMb: Math.round(Number(cap.memTotal) / (1024 * 1024)),
              diskGb: Math.round(Number(cap.diskTotal) / (1024 * 1024 * 1024)),
            });
          }
        }

        // Status reconcile, on its own much slower clock - see APP_STATUS_RECONCILE_MS.
        if (now - lastStatusReconcileAt >= APP_STATUS_RECONCILE_MS) {
          lastStatusReconcileAt = now;
          await reconcileAppStatusFromTelemetry(serverId, byProject);
        }
      }

      // A clean end at full lifetime is the deadline rotation (or a shutdown). Reconnect
      // at once: no backoff, no health write, ~100ms of gap - two orders of magnitude
      // under GAP_MS, so it never draws a band.
      if (
        !signal.aborted &&
        !state.stopping &&
        Date.now() - openedAt < MIN_STREAM_MS
      ) {
        const delay = backoffFor(attempt);
        attempt = Math.min(attempt + 1, 16);
        await sleep(delay, signal);
      }
    } catch (e) {
      // Aborted mid-flight (the server was removed, or shutdown): the channel we
      // closed surfaces as a transport error - a teardown, not a health event.
      if (signal.aborted || state.stopping) return;

      if (e instanceof AgentMetricsStreamUnsupportedError) {
        // Not a failure - this one server's agent predates the stream. Demote it
        // alone and keep the rest of the fleet streaming. Recorded so the app tab
        // can name the real cause: the poll path carries HOST metrics only, so no
        // container on this server will ever report.
        markMetricsStreamUnsupported(serverId);
        conn?.close();
        await runPollLoop(serverId, signal);
        return;
      }

      // DEADLINE_EXCEEDED is only the benign 55-min rotation when the stream actually
      // LIVED.
      const lifetime = openedAt === null ? 0 : Date.now() - openedAt;
      const rotation =
        e instanceof AgentUnreachableError &&
        e.code === GrpcStatus.DEADLINE_EXCEEDED &&
        lifetime >= MIN_STREAM_MS;

      if (!rotation) {
        // A real failure. Record it once, then back off. Deliberately do NOT
        // record health on every retry - a host down for an hour would otherwise
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
      signal.removeEventListener("abort", onAbort);
      conn?.close();
    }
  }
}

/**
 * The degradation path, kept PERMANENTLY rather than only through the rollout: a
 * fleet is updated server by server, and nothing stops someone registering a
 * server running last year's agent tomorrow. HOST METRICS ONLY, deliberately.
 */
async function runPollLoop(
  serverId: string,
  signal: AbortSignal,
): Promise<void> {
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
 *  away. Idempotent - safe to call on a timer. */
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
    // A migration source is not part of the fleet: no telemetry stream is opened to it,
    // because we do not operate that machine and nobody is watching a chart of it.
    if (s.importOnly) continue;
    live.add(s.id);
    if (state.servers.has(s.id)) continue;

    const abort = new AbortController();
    const mode: StreamMode = forcePollMode() ? "poll" : "stream";
    const entry: ServerStream = { mode, abort, loop: Promise.resolve() };
    state.servers.set(s.id, entry);
    entry.loop = (
      mode === "poll"
        ? runPollLoop(s.id, abort.signal)
        : runStreamLoop(s.id, s.name, s.storageOnly, abort.signal)
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

  // The PRUNE half of the RAM buffers' lifecycle, on the same 30s tick: only DELETION
  // forgets a resource's window (absence from a frame never does - see
  // container-history.ts), and this is where deletion becomes visible.
  pruneMetricsHistoryTo(new Set(servers.map((s) => s.id)));
  try {
    const [appRows, dbRows] = await Promise.all([
      getDb().select({ id: appsTable.id }).from(appsTable),
      getDb().select({ id: databasesTable.id }).from(databasesTable),
    ]);
    pruneContainerHistoryTo(
      new Set([...appRows.map((r) => r.id), ...dbRows.map((r) => r.id)]),
    );
  } catch {
    // DB blip; the next tick prunes.
  }
}

/** Start the supervisor. Idempotent; never throws into the caller. */
export function startMetricsStreams(): void {
  if (state.started) return;
  state.started = true;
  state.stopping = false;

  if (forcePollMode()) {
    console.warn(
      "[deplo] DEPLO_MONITORING_FORCE_POLL=1 - telemetry streams disabled, polling every server",
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
