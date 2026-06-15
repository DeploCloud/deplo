import "server-only";

import { read } from "../store";
import { assertUser } from "../auth";

/** Deterministic pseudo-random so SSR output is stable (no hydration drift). */
function seeded(seed: number) {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export interface UsageMetric {
  label: string;
  used: number;
  limit: number;
  unit: string;
}

export interface UsageData {
  metrics: UsageMetric[];
  totals: {
    requests: number;
    bandwidthGb: number;
    avgResponseMs: number;
    errorRate: number;
  };
}

export async function getUsage(days = 30): Promise<UsageData> {
  await assertUser();
  const projects = read().projects.length || 1;
  const rng = seeded(days * 7 + projects * 13 + 99);

  let totalReq = 0;
  let totalBw = 0;
  for (let i = 0; i < days; i++) {
    const base = 1800 + projects * 600;
    const req = Math.round(base + rng() * base * 0.8);
    const bw = +(req * 0.0009 + rng() * 0.6).toFixed(2);
    totalReq += req;
    totalBw += bw;
  }

  return {
    metrics: [
      { label: "Fluid Active CPU", used: 47.65, limit: 240, unit: "min" },
      { label: "Blob Simple Operations", used: 1400, limit: 10000, unit: "ops" },
      { label: "Blob Advanced Operations", used: 251, limit: 2000, unit: "ops" },
      { label: "Edge Requests", used: 53000, limit: 1000000, unit: "req" },
      { label: "Fast Data Transfer", used: totalBw, limit: 100, unit: "GB" },
      { label: "Function Invocations", used: Math.round(totalReq / 10), limit: 1000000, unit: "inv" },
    ],
    totals: {
      requests: totalReq,
      bandwidthGb: +totalBw.toFixed(1),
      avgResponseMs: Math.round(60 + rng() * 80),
      errorRate: +(rng() * 0.6).toFixed(2),
    },
  };
}
