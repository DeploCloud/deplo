import "server-only";

import os from "node:os";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";

/**
 * Real metrics for the host running the control plane. Uses node:os (portable)
 * plus Linux-only sources (df, /proc/net/dev) where available. No value is
 * fabricated — fields that cannot be measured are returned as 0.
 */
export interface HostMetrics {
  cpu: number; // 0-100
  cpuCores: number;
  memUsed: number; // bytes
  memTotal: number;
  memPct: number;
  diskUsed: number; // bytes
  diskTotal: number;
  diskPct: number;
  netRx: number; // bytes/sec
  netTx: number; // bytes/sec
  load: [number, number, number];
  uptimeSec: number;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

/** Instantaneous CPU utilisation from two os.cpus() samples. */
async function cpuPercent(sampleMs = 200): Promise<number> {
  const a = cpuTimes();
  await sleep(sampleMs);
  const b = cpuTimes();
  const idle = b.idle - a.idle;
  const total = b.total - a.total;
  if (total <= 0) return 0;
  return Math.max(0, Math.min(100, (1 - idle / total) * 100));
}

function dfBytes(path: string): Promise<{ used: number; total: number }> {
  return new Promise((resolve) => {
    execFile(
      "df",
      ["-kP", path],
      { timeout: 5_000, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve({ used: 0, total: 0 });
          return;
        }
        const line = stdout.trim().split("\n").pop() ?? "";
        const cols = line.split(/\s+/);
        // Filesystem 1024-blocks Used Available Capacity Mounted
        const totalKb = Number(cols[1]) || 0;
        const usedKb = Number(cols[2]) || 0;
        resolve({ used: usedKb * 1024, total: totalKb * 1024 });
      },
    );
  });
}

async function netCounters(): Promise<{ rx: number; tx: number }> {
  try {
    const raw = await readFile("/proc/net/dev", "utf8");
    let rx = 0;
    let tx = 0;
    for (const line of raw.split("\n")) {
      const m = line.match(/^\s*([^:]+):\s*(.*)$/);
      if (!m) continue;
      const iface = m[1].trim();
      if (iface === "lo") continue;
      const f = m[2].trim().split(/\s+/).map(Number);
      // 0: rx bytes, 8: tx bytes
      rx += f[0] || 0;
      tx += f[8] || 0;
    }
    return { rx, tx };
  } catch {
    return { rx: 0, tx: 0 };
  }
}

/** A real point-in-time snapshot of the host. Takes ~1s (net sample window). */
export async function hostMetrics(dataDir = "/"): Promise<HostMetrics> {
  const memTotal = os.totalmem();
  const memFree = os.freemem();
  const memUsed = Math.max(0, memTotal - memFree);

  const [cpu, disk, net1] = await Promise.all([
    cpuPercent(),
    dfBytes(dataDir),
    netCounters(),
  ]);
  await sleep(1000);
  const net2 = await netCounters();

  const load = os.loadavg() as [number, number, number];

  return {
    cpu: +cpu.toFixed(1),
    cpuCores: os.cpus().length || 1,
    memUsed,
    memTotal,
    memPct: memTotal > 0 ? +((memUsed / memTotal) * 100).toFixed(1) : 0,
    diskUsed: disk.used,
    diskTotal: disk.total,
    diskPct: disk.total > 0 ? +((disk.used / disk.total) * 100).toFixed(1) : 0,
    netRx: Math.max(0, net2.rx - net1.rx),
    netTx: Math.max(0, net2.tx - net1.tx),
    load: [
      +load[0].toFixed(2),
      +load[1].toFixed(2),
      +load[2].toFixed(2),
    ],
    uptimeSec: Math.floor(os.uptime()),
  };
}

/** Cheap static facts about the host (no sampling delay). */
export function hostFacts(): { cpuCores: number; memTotal: number } {
  return { cpuCores: os.cpus().length || 1, memTotal: os.totalmem() };
}
