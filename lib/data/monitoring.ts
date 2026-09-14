import "server-only";

import { getServer, listServers } from "./servers/roster";
import { hasCapability, requireCapability } from "../membership";
import { connectAgent } from "../infra/agent-client/connect";
import { markServerSeen, observedTraefik } from "./servers/agent-handshake";
import { recordServerHealth } from "./server-health";
import { classifyServerHealth } from "../infra/server-health";
import { reportedAgentVersion } from "../version";
import { resolveExpectedAgentVersion } from "../agent/release";
import { nowIso } from "../ids";
import { getMetricsHistory, recordMetricsSample } from "../monitoring/history";
import { downsample } from "../monitoring/chart-geometry";
import { isMetricsSavingEnabled } from "./monitoring-settings";
import type { Server } from "../types/server";

// ServerMetrics - one server's live reading.
export interface ServerMetrics {
  serverId: string;
  online: boolean;
  traefik: boolean;
  cpu: number;
  cpuCores: number;
  memUsed: number;
  memTotal: number;
  memPct: number;
  memFree: number;
  memCache: number;
  diskUsed: number;
  diskTotal: number;
  diskPct: number;
  netRx: number;
  netTx: number;
  load: [number, number, number];
  uptimeSec: number;
  containers: number;
  agentVersion: string | null;
  expectedAgentVersion: string;
  // Which backend produced it: "cgroup2" | "docker-stats", empty when not from a frame.
  source: string;
  ts: number;
}

function agentVersionFields(
  expected: string,
  server?: Server,
): Pick<ServerMetrics, "agentVersion" | "expectedAgentVersion"> {
  const agentVersion = server ? reportedAgentVersion(server) : null;
  return { agentVersion, expectedAgentVersion: expected };
}

function unavailable(
  serverId: string,
  expected: string,
  server?: Server,
): ServerMetrics {
  return {
    serverId,
    online: false,
    traefik: false,
    cpu: 0,
    // The server's OWN stored core count: os.cpus() here reports the control plane's.
    cpuCores: server?.cpuCores ?? 0,
    memUsed: 0,
    memTotal: 0,
    memPct: 0,
    memFree: 0,
    memCache: 0,
    diskUsed: 0,
    diskTotal: 0,
    diskPct: 0,
    netRx: 0,
    netTx: 0,
    load: [0, 0, 0],
    uptimeSec: 0,
    containers: 0,
    ...agentVersionFields(expected, server),
    source: "",
    ts: Date.now(),
  };
}

// An unreachable agent reports online:false - never fabricated, never this machine's numbers.
async function measureRemote(
  server: Server,
  expected: string,
): Promise<ServerMetrics> {
  const observedAt = nowIso();
  const conn = await connectAgent(server.id);
  try {
    // Empty dataDir => the agent measures its own configured --data-dir.
    const m = await conn.metrics("");
    // The only steady-state path: without it, traefikEnabled would update only on a deploy.
    let traefik = server.traefikEnabled;
    // From THIS poll's Hello, so a just-updated agent self-corrects in the same snapshot.
    let liveAgentVersion: string | null = reportedAgentVersion(server);
    try {
      const hello = await conn.hello();
      // ?? traefik keeps the last-known flag when the Hello observed nothing (Docker down).
      traefik = observedTraefik(hello) ?? traefik;
      if (hello.agentVersion) liveAgentVersion = hello.agentVersion;
      await markServerSeen(
        server.id,
        hello.agentVersion,
        observedTraefik(hello),
        {
          cpuCores: m.cpuCores,
          memoryMb: Math.round(Number(m.memTotal) / (1024 * 1024)),
          diskGb: Math.round(Number(m.diskTotal) / (1024 * 1024 * 1024)),
        },
        hello.dockerVersion,
        hello.hostArch,
      );
      await recordServerHealth(
        server.id,
        classifyServerHealth(hello, null, { storageOnly: server.storageOnly }),
        observedAt,
      );
    } catch {
      /* metrics succeeded; the Hello refresh is best-effort */
    }
    return {
      serverId: server.id,
      online: true,
      traefik,
      cpu: m.cpu,
      cpuCores: m.cpuCores,
      memUsed: Number(m.memUsed),
      memTotal: Number(m.memTotal),
      memPct: m.memPct,
      memFree: Number(m.memFree),
      memCache: Number(m.memCache),
      diskUsed: Number(m.diskUsed),
      diskTotal: Number(m.diskTotal),
      diskPct: m.diskPct,
      netRx: Number(m.netRx),
      netTx: Number(m.netTx),
      load: [m.load1, m.load5, m.load15],
      uptimeSec: Number(m.uptimeSec),
      containers: m.runningContainers,
      agentVersion: liveAgentVersion,
      expectedAgentVersion: expected,
      // The one-shot RPC carries no backend label; only a stream frame does.
      source: "",
      ts: Date.now(),
    };
  } finally {
    conn.close();
  }
}

async function metricsFor(
  server: Server,
  expected: string,
): Promise<ServerMetrics> {
  try {
    return await measureRemote(server, expected);
  } catch {
    return unavailable(server.id, expected, server);
  }
}

export async function getServerMetrics(
  serverId: string,
): Promise<ServerMetrics> {
  // Enforced here, not only in the resolver.
  await requireCapability("view_metrics");
  // Team-scoped: getServer is null for a server this team cannot target.
  const server = await getServer(serverId);
  if (!server) throw new Error("Server not found");
  const m = await metricsFor(server, await resolveExpectedAgentVersion());
  if (await isMetricsSavingEnabled()) recordMetricsSample(m);
  return m;
}

// getServerMetricsHistory - the buffered history the Monitoring page seeds its charts from.
export async function getServerMetricsHistory(
  serverId: string,
): Promise<ServerMetrics[]> {
  // Soft (empty) rather than a throw: this one seeds a chart on page load.
  if (!(await hasCapability("view_metrics"))) return [];
  const server = await getServer(serverId);
  if (!server) throw new Error("Server not found");
  return getMetricsHistory(serverId);
}

const FLEET_SPARK_POINTS = 30;

// FleetSpark - one point of a fleet row's sparkline.
export interface FleetSpark {
  ts: number;
  cpu: number;
  mem: number;
}

// FleetServerMetrics - one fleet row; ts: 0 means the buffer is empty, not an idle host.
export interface FleetServerMetrics {
  serverId: string;
  online: boolean;
  ts: number;
  cpu: number;
  memPct: number;
  diskPct: number;
  containers: number;
  agentVersion: string | null;
  expectedAgentVersion: string;
  source: string;
  spark: FleetSpark[];
}

// getFleetMetrics - every server's headline reading, read from the in-RAM buffers alone.
export async function getFleetMetrics(): Promise<FleetServerMetrics[]> {
  if (!(await hasCapability("view_metrics"))) return [];
  const servers = await listServers();
  return servers
    .filter((s) => !s.importOnly)
    .map((server) => {
      const history = getMetricsHistory(server.id);
      const last = history[history.length - 1];
      return {
        serverId: server.id,
        online: Boolean(last),
        ts: last?.ts ?? 0,
        cpu: last?.cpu ?? 0,
        memPct: last?.memPct ?? 0,
        diskPct: last?.diskPct ?? 0,
        containers: last?.containers ?? 0,
        agentVersion: reportedAgentVersion(server),
        expectedAgentVersion: last?.expectedAgentVersion ?? "",
        source: last?.source ?? "",
        spark: downsample(history, FLEET_SPARK_POINTS).map((h) => ({
          ts: h.ts,
          cpu: h.cpu,
          mem: h.memPct,
        })),
      };
    });
}

// measureServerForCollector - session-free measure for the collector; takes a resolved Server row.
export const measureServerForCollector = metricsFor;

function withSpecTimeout<T>(p: Promise<T>, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("spec measure timed out")), ms);
  });
  return Promise.race([p.finally(() => clearTimeout(timer)), timeout]);
}

// hydrateServerSpecs - fill in each server's cores / RAM / disk for a STATIC render.
export async function hydrateServerSpecs(servers: Server[]): Promise<Server[]> {
  // A migration source is never measured: this dial happens INSIDE the page render.
  const measurable = (s: Server) =>
    s.cpuCores === 0 && Boolean(s.agent?.certFingerprint) && !s.importOnly;
  if (!servers.some(measurable)) return servers;
  const expected = await resolveExpectedAgentVersion();
  return Promise.all(
    servers.map(async (s) => {
      if (!measurable(s)) return s;
      try {
        // This runs synchronously in the page render, so an unreachable host must fail fast.
        const m = await withSpecTimeout(measureRemote(s, expected));
        if (m.cpuCores <= 0) return s;
        return {
          ...s,
          cpuCores: m.cpuCores,
          memoryMb: Math.round(m.memTotal / (1024 * 1024)),
          diskGb: Math.round(m.diskTotal / (1024 * 1024 * 1024)),
          traefikEnabled: m.traefik,
        };
      } catch {
        return s;
      }
    }),
  );
}
