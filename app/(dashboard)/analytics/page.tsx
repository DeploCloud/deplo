import {
  Users,
  Eye,
  Activity as ActivityIcon,
  Gauge,
  Timer,
  TriangleAlert,
} from "lucide-react";
import { getAnalytics } from "@/lib/data/analytics";
import type { TimeSeriesPoint } from "@/lib/data/analytics";
import { PageHeader } from "@/components/shared/page-header";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PeriodSelect } from "./period-select";

export const metadata = { title: "Analytics" };

const ALLOWED_DAYS = new Set([7, 30, 90]);

function parseDays(raw: string | string[] | undefined): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return ALLOWED_DAYS.has(n) ? n : 30;
}

function formatCompact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

export default async function AnalyticsPage(props: PageProps<"/analytics">) {
  const sp = await props.searchParams;
  const days = parseDays(sp.days);
  const data = await getAnalytics(days);

  const stats: { label: string; value: string; icon: typeof Users }[] = [
    { label: "Visitors", value: formatCompact(data.totals.visitors), icon: Users },
    { label: "Page Views", value: formatCompact(data.totals.pageViews), icon: Eye },
    { label: "Requests", value: formatCompact(data.totals.requests), icon: ActivityIcon },
    { label: "Bandwidth (GB)", value: data.totals.bandwidthGb.toFixed(1), icon: Gauge },
    { label: "Avg Response (ms)", value: `${data.totals.avgResponseMs}`, icon: Timer },
    { label: "Error Rate (%)", value: `${data.totals.errorRate.toFixed(2)}`, icon: TriangleAlert },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title="Analytics"
        description="Traffic, performance and bandwidth across your deployments."
        actions={<PeriodSelect days={days} />}
      />

      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        {stats.map((s) => {
          const Icon = s.icon;
          return (
            <Card key={s.label}>
              <CardContent className="space-y-1.5 p-4">
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <Icon className="size-4" />
                  <span className="text-xs">{s.label}</span>
                </div>
                <p className="text-2xl font-semibold tracking-tight">{s.value}</p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Charts */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Requests over time</CardTitle>
            <p className="text-xs text-muted-foreground">
              {formatCompact(data.totals.requests)} total over {days} days
            </p>
          </CardHeader>
          <CardContent>
            <AreaChart points={data.requests} />
            <ChartAxis points={data.requests} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Bandwidth</CardTitle>
            <p className="text-xs text-muted-foreground">
              {data.totals.bandwidthGb.toFixed(1)} GB total over {days} days
            </p>
          </CardHeader>
          <CardContent>
            <BarChart points={data.bandwidthGb} />
            <ChartAxis points={data.bandwidthGb} />
          </CardContent>
        </Card>
      </div>

      {/* Top pages */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Top Pages</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>Path</span>
              <span>Views</span>
            </div>
            {data.topPaths.map((p) => (
              <div key={p.path} className="space-y-1.5">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="truncate font-mono text-xs text-foreground">
                    {p.path}
                  </span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatCompact(p.views)}
                    <span className="ml-2 text-xs">{p.pct}%</span>
                  </span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full rounded-full bg-foreground/80"
                    style={{ width: `${Math.max(p.pct, 2)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

/** Inline SVG area chart with gradient fill + stroke polyline. */
function AreaChart({ points }: { points: TimeSeriesPoint[] }) {
  const W = 600;
  const H = 192;
  const pad = 4;
  const gradientId = "analytics-area-gradient";

  if (points.length === 0) {
    return <div className="h-48 w-full rounded-lg bg-secondary/40" />;
  }

  const values = points.map((p) => p.value);
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const range = max - min || 1;
  const stepX = points.length > 1 ? (W - pad * 2) / (points.length - 1) : 0;

  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    // Leave a little headroom at the top so the peak isn't clipped.
    const y = pad + (H - pad * 2) * (1 - (p.value - min) / range) * 0.92;
    return [x, y] as const;
  });

  const line = coords.map(([x, y]) => `${x},${y}`).join(" ");
  const area = `M ${coords[0][0]},${H} L ${coords
    .map(([x, y]) => `${x},${y}`)
    .join(" L ")} L ${coords[coords.length - 1][0]},${H} Z`;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-48 w-full text-foreground"
      role="img"
      aria-label="Requests over time"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gradientId})`} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Inline SVG vertical-bar chart. */
function BarChart({ points }: { points: TimeSeriesPoint[] }) {
  const W = 600;
  const H = 192;
  const pad = 4;

  if (points.length === 0) {
    return <div className="h-48 w-full rounded-lg bg-secondary/40" />;
  }

  const max = Math.max(...points.map((p) => p.value), 1);
  const slot = (W - pad * 2) / points.length;
  const gap = Math.min(slot * 0.3, 4);
  const barW = Math.max(slot - gap, 1);

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-48 w-full text-foreground"
      role="img"
      aria-label="Bandwidth per day"
    >
      {points.map((p, i) => {
        const h = Math.max((H - pad * 2) * (p.value / max), 1);
        const x = pad + i * slot + gap / 2;
        const y = H - pad - h;
        return (
          <rect
            key={p.date}
            x={x}
            y={y}
            width={barW}
            height={h}
            rx="2"
            className="fill-foreground/70 transition-colors hover:fill-foreground"
          >
            <title>{`${p.date}: ${p.value} GB`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

/** First / last date labels under a chart. */
function ChartAxis({ points }: { points: TimeSeriesPoint[] }) {
  if (points.length === 0) return null;
  const first = points[0].date;
  const last = points[points.length - 1].date;
  return (
    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
      <span>{first}</span>
      <span>{last}</span>
    </div>
  );
}
