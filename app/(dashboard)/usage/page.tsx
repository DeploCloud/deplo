import Link from "next/link";
import { Activity, ArrowRight, Gauge, HardDrive, Zap } from "lucide-react";
import { getUsage } from "@/lib/data/usage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { PageHeader } from "@/components/shared/page-header";

export const metadata = { title: "Usage" };

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

export default async function UsagePage() {
  const data = await getUsage(30);
  const { totals, metrics } = data;

  const summary = [
    {
      label: "Requests",
      value: fmt(totals.requests),
      icon: Zap,
    },
    {
      label: "Bandwidth",
      value: `${totals.bandwidthGb} GB`,
      icon: HardDrive,
    },
    {
      label: "Avg Response",
      value: `${totals.avgResponseMs} ms`,
      icon: Gauge,
    },
    {
      label: "Error Rate",
      value: `${totals.errorRate}%`,
      icon: Activity,
    },
  ];

  return (
    <div className="space-y-8">
      <PageHeader
        title="Usage"
        description="Resource consumption across all your projects."
        actions={<Badge variant="secondary">Last 30 days</Badge>}
      />

      {/* Summary strip */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {summary.map((s) => (
          <Card key={s.label}>
            <CardContent className="flex items-center justify-between gap-3 py-5">
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">{s.label}</p>
                <p className="text-2xl font-semibold tracking-tight">
                  {s.value}
                </p>
              </div>
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary">
                <s.icon className="size-4 text-muted-foreground" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Usage metrics */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Resource limits</CardTitle>
          <CardDescription>
            Usage resets at the start of each billing cycle.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-7">
          {metrics.map((m) => {
            const pct = Math.min(100, (m.used / m.limit) * 100);
            const over = pct > 80;
            return (
              <div key={m.label} className="space-y-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium">{m.label}</span>
                  <span className="font-mono text-xs text-muted-foreground">
                    {fmt(m.used)} / {fmt(m.limit)} {m.unit}
                  </span>
                </div>
                <Progress
                  value={pct}
                  className="h-2"
                  indicatorClassName={
                    over ? "bg-[var(--warning)]" : undefined
                  }
                />
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Plan callout */}
      <Card>
        <CardContent className="flex flex-col items-start justify-between gap-4 py-6 sm:flex-row sm:items-center">
          <div className="space-y-1">
            <p className="text-sm font-semibold">You are on the Hobby plan.</p>
            <p className="text-sm text-muted-foreground">
              Upgrade for higher limits.
            </p>
          </div>
          <Button variant="outline" asChild>
            <Link href="/settings">
              Upgrade
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
