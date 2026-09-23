import "server-only";

import { status as GrpcStatus } from "@grpc/grpc-js";

import { listAllServers } from "../data/servers/roster";
import {
  markServerSeen,
  observedTraefik,
} from "../data/servers/agent-handshake";
import { recordServerHealth } from "../data/server-health";
import { classifyServerHealth } from "../infra/server-health";
import type { AgentConnection } from "../infra/agent-client/connection";
import {
  AgentMetricsStreamUnsupportedError,
  AgentUnreachableError,
} from "../infra/agent-client/errors";
import { connectMetricsStreamAgent } from "../infra/agent-client/preflight";
import { isMetricsSavingEnabled } from "../data/monitoring-settings";
import { measureServerForCollector } from "../data/monitoring";
import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { databases as databasesTable } from "../db/schema/control-plane/databases";
import {
  aggregateContainerStats,
  toContainerSample,
} from "../data/container-metrics";
import { reconcileAppStatusFromTelemetry } from "../data/app-status-reconcile";
import { resolveExpectedAgentVersion } from "../agent/release";
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

// Move it and GAP_MS must move too - chart-gaps.test.ts pins the relationship.
export const RECONNECT_BACKOFF_CAP_MS = 10_000;

export const STREAM_INTERVAL_MS = 5_000;

const MIN_STREAM_MS = STREAM_INTERVAL_MS;

// Must stay under the 15s THROTTLE_MS in lib/data/server-health.ts, or the heartbeat is dropped.
export const HEALTH_WRITE_MS = 8_000;

export const APP_STATUS_RECONCILE_MS = 30_000;

const RECONCILE_MS = 30_000;

const POLL_FALLBACK_MS = 5_000;

function forcePollMode(): boolean {
  return process.env.DEPLO_MONITORING_FORCE_POLL === "1";
}

type StreamMode = "stream" | "poll";

type MetricsConnector = typeof connectMetricsStreamAgent;

let connector: MetricsConnector = connectMetricsStreamAgent;

export function __setMetricsConnectorForTest(fn?: MetricsConnector): void {
  connector = fn ?? connectMetricsStreamAgent;
}

interface ServerStream {
  mode: StreamMode;
  abort: AbortController;
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

interface ConnectionFacts {
  agentVersion: string | null;
  traefik: boolean;
  expectedAgentVersion: string;
  serverName: string;
}

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
    source: frame.source,
    // Stamped on receipt, not from the frame: host clock skew must never move a chart point.
    ts: Date.now(),
  };
}

async function ingestFrame(
  serverId: string,
  frame: MetricsSample,
  facts: ConnectionFacts,
): Promise<Map<string, ContainerStat[]>> {
  const host = hostSampleFrom(serverId, frame, facts);
  // Above the save-metrics gate on purpose: turning charts off must not turn alerting off.
  if (host)
    checkResourceThresholds(serverId, facts.serverName || serverId, host);
  if (host && (await isMetricsSavingEnabled())) recordMetricsSample(host);

  const byProject = new Map<string, ContainerStat[]>();
  for (const c of frame.containers) {
    if (!c.projectId) continue;
    const bucket = byProject.get(c.projectId);
    if (bucket) bucket.push(c);
    else byProject.set(c.projectId, [c]);
  }
  const ts = Date.now();
  const capacity = {
    memTotal: host?.memTotal ?? 0,
    cpuCores: host?.cpuCores ?? 0,
  };
  for (const [projectId, stats] of byProject) {
    const agg = aggregateContainerStats(projectId, stats, ts, capacity);
    recordContainerInstances(projectId, agg.instances);
    recordContainerSample(toContainerSample(agg));
  }
  return byProject;
}

export function backoffFor(attempt: number): number {
  const base = Math.min(RECONNECT_BACKOFF_CAP_MS, 1_000 * 2 ** attempt);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  return Math.max(250, Math.round(base + jitter));
}

// The signal lives as long as the server's loop: a listener left on it per tick is a leak.
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runStreamLoop(
  serverId: string,
  serverName: string,
  storageOnly: boolean,
  signal: AbortSignal,
): Promise<void> {
  let attempt = 0;

  while (!signal.aborted && !state.stopping) {
    let conn: AgentConnection | null = null;
    let openedAt: number | null = null;
    // streamMetrics takes no AbortSignal (the RPC deadline is the contract's only cancel), so abort closes the channel.
    const onAbort = () => conn?.close();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const opened = await connector(serverId);
      conn = opened.conn;
      const hello: HelloResponse = opened.hello;
      openedAt = Date.now();
      clearMetricsStreamUnsupported(serverId);

      const facts: ConnectionFacts = {
        agentVersion: hello.agentVersion || null,
        traefik: hello.traefikRunning,
        expectedAgentVersion: await resolveExpectedAgentVersion(),
        serverName,
      };

      const connHealth = classifyServerHealth(hello, null, { storageOnly });

      await markServerSeen(
        serverId,
        hello.agentVersion,
        observedTraefik(hello),
        undefined,
        hello.dockerVersion,
        hello.hostArch,
      );
      let lastHealthWriteAt = Date.now();
      let lastStatusReconcileAt = 0;
      await recordServerHealth(serverId, connHealth, new Date().toISOString());

      for await (const frame of conn.streamMetrics({
        dataDir: "",
        intervalMs: STREAM_INTERVAL_MS,
        includeContainers: true,
      })) {
        if (signal.aborted || state.stopping) break;
        // Only a received frame resets it: resetting at connect re-dialled hot forever when a stream died at the dial.
        attempt = 0;

        const byProject = await ingestFrame(serverId, frame, facts);

        const now = Date.now();
        if (now - lastHealthWriteAt >= HEALTH_WRITE_MS) {
          lastHealthWriteAt = now;
          await recordServerHealth(
            serverId,
            connHealth,
            new Date(now).toISOString(),
          );
          const cap = frame.host;
          if (cap && cap.cpuCores > 0) {
            await markServerSeen(serverId, undefined, undefined, {
              cpuCores: cap.cpuCores,
              memoryMb: Math.round(Number(cap.memTotal) / (1024 * 1024)),
              diskGb: Math.round(Number(cap.diskTotal) / (1024 * 1024 * 1024)),
            });
          }
        }

        if (now - lastStatusReconcileAt >= APP_STATUS_RECONCILE_MS) {
          lastStatusReconcileAt = now;
          await reconcileAppStatusFromTelemetry(serverId, byProject);
        }
      }

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
      if (signal.aborted || state.stopping) return;

      if (e instanceof AgentMetricsStreamUnsupportedError) {
        markMetricsStreamUnsupported(serverId);
        conn?.close();
        await runPollLoop(serverId, signal);
        return;
      }

      const lifetime = openedAt === null ? 0 : Date.now() - openedAt;
      const rotation =
        e instanceof AgentUnreachableError &&
        e.code === GrpcStatus.DEADLINE_EXCEEDED &&
        lifetime >= MIN_STREAM_MS;

      if (!rotation) {
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
    } catch {}
    await sleep(POLL_FALLBACK_MS, signal);
  }
}

export async function reconcileMetricsStreams(): Promise<void> {
  if (state.stopping) return;
  let servers: Awaited<ReturnType<typeof listAllServers>>;
  try {
    servers = await listAllServers();
  } catch {
    return;
  }

  const live = new Set<string>();
  for (const s of servers) {
    if (!s.agent?.certFingerprint) continue;
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

  pruneMetricsHistoryTo(new Set(servers.map((s) => s.id)));
  try {
    const [appRows, dbRows] = await Promise.all([
      getDb().select({ id: appsTable.id }).from(appsTable),
      getDb().select({ id: databasesTable.id }).from(databasesTable),
    ]);
    pruneContainerHistoryTo(
      new Set([...appRows.map((r) => r.id), ...dbRows.map((r) => r.id)]),
    );
  } catch {}
}

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

export function __streamModes(): Record<string, StreamMode> {
  const out: Record<string, StreamMode> = {};
  for (const [id, e] of state.servers) out[id] = e.mode;
  return out;
}
