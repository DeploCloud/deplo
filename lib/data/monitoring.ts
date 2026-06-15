import "server-only";

import { read } from "../store";
import { assertUser } from "../auth";
import type { DeploData, Server } from "../types";

/**
 * Live server metrics, Dokploy-style: a point-in-time snapshot of real machine
 * resources (CPU, memory, disk, network, load) for one host. Values jitter
 * around each server's stored baseline so a polling client renders a moving,
 * real-time view. Offline / provisioning servers report no live data.
 */
export interface ServerMetrics {
  serverId: string;
  online: boolean;
  /** CPU utilisation, 0-100. */
  cpu: number;
  cpuCores: number;
  /** Memory in bytes. */
  memUsed: number;
  memTotal: number;
  memPct: number;
  /** Disk in bytes. */
  diskUsed: number;
  diskTotal: number;
  diskPct: number;
  /** Network throughput in bytes per second. */
  netRx: number;
  netTx: number;
  /** Load average over 1 / 5 / 15 minutes. */
  load: [number, number, number];
  uptimeSec: number;
  containers: number;
  /** Sample timestamp (epoch ms). */
  ts: number;
}

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));

/**
 * Wobble a baseline value with a slow sine wave plus a little white noise, so
 * successive samples drift like a real metric instead of jumping randomly.
 */
function jitter(base: number, amp: number): number {
  const t = Date.now() / 1000;
  const wave = Math.sin(t / 6 + base) * amp * 0.5;
  const noise = (Math.random() - 0.5) * amp;
  return base + wave + noise;
}

function sampleServerMetrics(server: Server, d: DeploData): ServerMetrics {
  const memTotal = server.memoryMb * MIB;
  const diskTotal = server.diskGb * GIB;
  const cpuCores = server.cpuCores;

  if (server.status !== "online") {
    return {
      serverId: server.id,
      online: false,
      cpu: 0,
      cpuCores,
      memUsed: 0,
      memTotal,
      memPct: 0,
      diskUsed: 0,
      diskTotal,
      diskPct: 0,
      netRx: 0,
      netTx: 0,
      load: [0, 0, 0],
      uptimeSec: 0,
      containers: 0,
      ts: Date.now(),
    };
  }

  const cpu = clamp(jitter(server.cpuUsage, 14));
  const memPct = clamp(jitter(server.memoryUsage, 8));
  const diskPct = clamp(jitter(server.diskUsage, 1.2));

  const containers =
    d.projects.filter((p) => p.serverId === server.id).length +
    d.databases.filter((x) => x.serverId === server.id).length;

  // Network roughly tracks CPU; inbound usually exceeds outbound.
  const netRx = Math.max(0, (cpu * 0.9 + Math.random() * 30) * 1024 * 12);
  const netTx = Math.max(0, (cpu * 0.5 + Math.random() * 20) * 1024 * 9);

  const load1 = +(cpuCores * (cpu / 100) * (0.8 + Math.random() * 0.4)).toFixed(2);

  return {
    serverId: server.id,
    online: true,
    cpu: +cpu.toFixed(1),
    cpuCores,
    memUsed: Math.round((memTotal * memPct) / 100),
    memTotal,
    memPct: +memPct.toFixed(1),
    diskUsed: Math.round((diskTotal * diskPct) / 100),
    diskTotal,
    diskPct: +diskPct.toFixed(1),
    netRx: Math.round(netRx),
    netTx: Math.round(netTx),
    load: [load1, +(load1 * 0.92).toFixed(2), +(load1 * 0.82).toFixed(2)],
    uptimeSec: Math.max(
      0,
      Math.floor((Date.now() - new Date(server.createdAt).getTime()) / 1000),
    ),
    containers,
    ts: Date.now(),
  };
}

/** Live snapshot for one server (polled by the monitoring dashboard). */
export async function getServerMetrics(serverId: string): Promise<ServerMetrics> {
  await assertUser();
  const d = read();
  const server = d.servers.find((s) => s.id === serverId);
  if (!server) throw new Error("Server not found");
  return sampleServerMetrics(server, d);
}

/** Live snapshot for every server (used for the first server-rendered paint). */
export async function getAllServerMetrics(): Promise<ServerMetrics[]> {
  await assertUser();
  const d = read();
  return d.servers.map((s) => sampleServerMetrics(s, d));
}
