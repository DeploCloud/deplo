import "server-only";

import { read } from "../store";
import { assertUser } from "../auth";
import { hostFacts } from "../infra/host";
import { connectAgent } from "../infra/agent-client";
import { markServerSeen } from "./servers";
import type { Server } from "../types";

/**
 * Real server metrics. EVERY server — including the host running Deplo — is
 * measured by its agent's Metrics RPC over mTLS (PLAN Part C): the agent measures
 * its own host (CPU/mem/disk + a live running-container count). An unreachable /
 * not-yet-provisioned agent reports no live data (online:false) rather than
 * fabricating any.
 */
export interface ServerMetrics {
  serverId: string;
  online: boolean;
  /**
   * Whether a Traefik reverse proxy is running on the server (read live from the
   * agent's Hello on this same poll). Carried in the live payload so the Traefik
   * badge updates without a page reload, like online/CPU — and self-corrects when
   * Traefik is added/removed. False when offline/unreachable.
   */
  traefik: boolean;
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
    traefik: false,
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
    // Read the Traefik state live on this same poll (the poll already holds the
    // mTLS connection open). This is the ONLY steady-state path — the deploy
    // preflight aside — so without it traefikEnabled would only ever update on a
    // deploy. Best-effort: a Hello failure doesn't fail the metrics snapshot;
    // we just keep the last-known traefik flag for the payload.
    let traefik = server.traefikEnabled;
    try {
      const hello = await conn.hello();
      traefik = hello.traefikRunning;
      // Persist the live value (read-live-not-stored, like health). The badge's
      // server-rendered render reads this on the next page load; the live payload
      // below updates it without a reload.
      markServerSeen(server.id, hello.agentVersion, hello.traefikRunning);
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
  try {
    return await measureRemote(server);
  } catch {
    // Unreachable / unprovisioned agent, or any transport error: report offline
    // rather than a fabricated snapshot.
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
    // Cheap hydration hint from the stored status; the first live poll replaces
    // it. A not-yet-provisioned server has no agent and reports offline, exactly
    // as metricsFor() would, keeping the card UI consistent.
    online: Boolean(s.agent?.certFingerprint) && s.status === "online",
    // Cheap hydration value from the stored flag; the first live poll replaces it.
    traefik: s.traefikEnabled,
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
