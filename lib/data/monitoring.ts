import "server-only";

import { read } from "../store";
import { assertUser } from "../auth";
import { hostMetrics, hostFacts } from "../infra/host";
import { dockerAvailable, listContainers } from "../infra/docker";
import { connectAgent, AgentUnreachableError } from "../infra/agent-client";
import type { Server } from "../types";

/**
 * Real server metrics. The host running the control plane (the localhost
 * "master") is measured directly via node:os, /proc and df, plus a live
 * container count from Docker. A REMOTE server is measured by its agent's
 * Metrics RPC (PLAN Part C); an unreachable agent reports no live data
 * (online:false) rather than fabricating any.
 */
export interface ServerMetrics {
  serverId: string;
  online: boolean;
  cpu: number;
  cpuCores: number;
  memUsed: number;
  memTotal: number;
  memPct: number;
  diskUsed: number;
  diskTotal: number;
  diskPct: number;
  netRx: number;
  netTx: number;
  load: [number, number, number];
  uptimeSec: number;
  containers: number;
  ts: number;
}

function unavailable(serverId: string): ServerMetrics {
  const facts = hostFacts();
  return {
    serverId,
    online: false,
    cpu: 0,
    cpuCores: facts.cpuCores,
    memUsed: 0,
    memTotal: 0,
    memPct: 0,
    diskUsed: 0,
    diskTotal: 0,
    diskPct: 0,
    netRx: 0,
    netTx: 0,
    load: [0, 0, 0],
    uptimeSec: 0,
    containers: 0,
    ts: Date.now(),
  };
}

async function measureLocal(serverId: string): Promise<ServerMetrics> {
  const m = await hostMetrics(process.env.DEPLO_DATA_DIR || "/");
  let containers = 0;
  if (await dockerAvailable()) {
    try {
      containers = (await listContainers()).filter(
        (c) => c.state === "running",
      ).length;
    } catch {
      /* leave 0 */
    }
  }
  return {
    serverId,
    online: true,
    cpu: m.cpu,
    cpuCores: m.cpuCores,
    memUsed: m.memUsed,
    memTotal: m.memTotal,
    memPct: m.memPct,
    diskUsed: m.diskUsed,
    diskTotal: m.diskTotal,
    diskPct: m.diskPct,
    netRx: m.netRx,
    netTx: m.netTx,
    load: m.load,
    uptimeSec: m.uptimeSec,
    containers,
    ts: Date.now(),
  };
}

/**
 * Measure a remote server via its agent's Metrics RPC. The agent measures its own
 * host (CPU/mem/disk of its --data-dir + a live running-container count) and
 * returns a HostMetrics, mapped 1:1 into ServerMetrics. An unreachable / not-yet-
 * provisioned agent reports no live data (online:false) — never fabricated, never
 * the control plane's own numbers.
 *
 * NOTE: the dashboard polls every ~1s, so this dials+closes a gRPC client per
 * poll per viewer. Acceptable at current scale; a connection pool is a Part C+
 * optimisation (TODO) if the fleet/viewer count makes the churn matter.
 */
async function measureRemote(server: Server): Promise<ServerMetrics> {
  const conn = await connectAgent(server.id);
  try {
    // Empty dataDir => the agent measures its own configured --data-dir.
    const m = await conn.metrics("");
    return {
      serverId: server.id,
      online: true,
      cpu: m.cpu,
      cpuCores: m.cpuCores,
      memUsed: Number(m.memUsed),
      memTotal: Number(m.memTotal),
      memPct: m.memPct,
      diskUsed: Number(m.diskUsed),
      diskTotal: Number(m.diskTotal),
      diskPct: m.diskPct,
      netRx: Number(m.netRx),
      netTx: Number(m.netTx),
      load: [m.load1, m.load5, m.load15],
      uptimeSec: Number(m.uptimeSec),
      containers: m.runningContainers,
      ts: Date.now(),
    };
  } finally {
    conn.close();
  }
}

async function metricsFor(server: Server): Promise<ServerMetrics> {
  if (server.type === "localhost") return measureLocal(server.id);
  try {
    return await measureRemote(server);
  } catch (e) {
    // Unreachable / unprovisioned agent, or any transport error: report offline
    // rather than the master's numbers or a fabricated snapshot.
    if (e instanceof AgentUnreachableError) return unavailable(server.id);
    return unavailable(server.id);
  }
}

export async function getServerMetrics(serverId: string): Promise<ServerMetrics> {
  await assertUser();
  const server = read().servers.find((s) => s.id === serverId);
  if (!server) throw new Error("Server not found");
  return metricsFor(server);
}

export async function getAllServerMetrics(): Promise<ServerMetrics[]> {
  await assertUser();
  return Promise.all(read().servers.map((s) => metricsFor(s)));
}

/**
 * Cheap, instant metrics for the initial server render. measureLocal() takes
 * ~1.2s (a 1s network-delta window + a 200ms CPU sample + docker calls), which
 * would block the Monitoring and Servers pages on every load. The client polls
 * the real metrics every second (see ServerMetricsProvider), so the server only
 * needs to supply a sensible hydration fallback: each server's last-known usage
 * from the store. No sampling, no docker, no sleep — the live values arrive on
 * the first client poll and replace these within ~1s.
 */
export async function getInitialServerMetrics(): Promise<ServerMetrics[]> {
  await assertUser();
  const facts = hostFacts();
  return read().servers.map((s) => ({
    serverId: s.id,
    // Remote servers have no agent yet, so they report no live data — mark them
    // offline exactly as metricsFor() would, to keep the card UI consistent.
    online: s.type === "localhost",
    cpu: s.cpuUsage,
    cpuCores: s.cpuCores || facts.cpuCores,
    memUsed: 0,
    memTotal: s.memoryMb * 1024 * 1024,
    memPct: s.memoryUsage,
    diskUsed: 0,
    diskTotal: s.diskGb * 1024 * 1024 * 1024,
    diskPct: s.diskUsage,
    netRx: 0,
    netTx: 0,
    load: [0, 0, 0],
    uptimeSec: 0,
    containers: 0,
    ts: Date.now(),
  }));
}
