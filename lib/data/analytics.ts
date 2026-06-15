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

export interface TimeSeriesPoint {
  date: string;
  value: number;
}

export interface AnalyticsData {
  metrics: UsageMetric[];
  requests: TimeSeriesPoint[];
  bandwidthGb: TimeSeriesPoint[];
  topPaths: { path: string; views: number; pct: number }[];
  totals: {
    visitors: number;
    pageViews: number;
    requests: number;
    bandwidthGb: number;
    avgResponseMs: number;
    errorRate: number;
  };
}

export async function getAnalytics(days = 30): Promise<AnalyticsData> {
  await assertUser();
  const projects = read().projects.length || 1;
  const rng = seeded(days * 7 + projects * 13 + 99);

  const requests: TimeSeriesPoint[] = [];
  const bandwidthGb: TimeSeriesPoint[] = [];
  let totalReq = 0;
  let totalBw = 0;
  for (let i = days - 1; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86400000)
      .toISOString()
      .slice(0, 10);
    const base = 1800 + projects * 600;
    const req = Math.round(base + rng() * base * 0.8);
    const bw = +(req * 0.0009 + rng() * 0.6).toFixed(2);
    requests.push({ date, value: req });
    bandwidthGb.push({ date, value: bw });
    totalReq += req;
    totalBw += bw;
  }

  const topPaths = [
    { path: "/", views: 0 },
    { path: "/blog/[slug]", views: 0 },
    { path: "/pricing", views: 0 },
    { path: "/docs", views: 0 },
    { path: "/api/og", views: 0 },
    { path: "/dashboard", views: 0 },
  ].map((p) => ({ ...p, views: Math.round(2000 + rng() * 8000) }));
  const sumViews = topPaths.reduce((a, b) => a + b.views, 0);
  topPaths.sort((a, b) => b.views - a.views);

  return {
    metrics: [
      { label: "Fluid Active CPU", used: 47.65, limit: 240, unit: "min" },
      { label: "Blob Simple Operations", used: 1400, limit: 10000, unit: "ops" },
      { label: "Blob Advanced Operations", used: 251, limit: 2000, unit: "ops" },
      { label: "Edge Requests", used: 53000, limit: 1000000, unit: "req" },
      { label: "Fast Data Transfer", used: totalBw, limit: 100, unit: "GB" },
      { label: "Function Invocations", used: Math.round(totalReq / 10), limit: 1000000, unit: "inv" },
    ],
    requests,
    bandwidthGb,
    topPaths: topPaths.map((p) => ({
      ...p,
      pct: Math.round((p.views / sumViews) * 100),
    })),
    totals: {
      visitors: Math.round(totalReq * 0.42),
      pageViews: Math.round(totalReq * 0.9),
      requests: totalReq,
      bandwidthGb: +totalBw.toFixed(1),
      avgResponseMs: Math.round(60 + rng() * 80),
      errorRate: +(rng() * 0.6).toFixed(2),
    },
  };
}
