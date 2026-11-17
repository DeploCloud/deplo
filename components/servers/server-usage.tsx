import * as React from "react";
import { Cpu, HardDrive, MemoryStick } from "lucide-react";

import { Progress } from "@/components/ui/progress";
import { cn, formatBytes } from "@/lib/utils";
import type { ServerUsage } from "@/lib/types/server";

/** Only the servers that answered count: one that is silent adds no capacity it cannot give. */
export function usageTotals(usages: (ServerUsage | null)[]): ServerUsage {
  const read = usages.filter((u): u is ServerUsage => u !== null);
  const sum = (f: (u: ServerUsage) => number) =>
    read.reduce((n, u) => n + f(u), 0);
  const cores = sum((u) => u.cores);
  return {
    cores,
    cpu: cores ? sum((u) => u.cpu * u.cores) / cores : 0,
    memUsed: sum((u) => u.memUsed),
    memTotal: sum((u) => u.memTotal),
    diskUsed: sum((u) => u.diskUsed),
    diskTotal: sum((u) => u.diskTotal),
  };
}

const pct = (used: number, total: number) =>
  total > 0 ? Math.min(100, (used / total) * 100) : 0;
const round = (n: number) =>
  n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;

export function UsageMeter({
  icon: Icon,
  label,
  value,
  percent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  percent: number;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="size-3.5" />
          {label}
        </span>
        <span className="tabular-nums">{value}</span>
      </div>
      <Progress
        value={value === "-" ? 0 : Math.max(percent, 1)}
        aria-label={label}
        className="h-1.5"
      />
    </div>
  );
}

/** CPU, memory and disk of one server, or of a cluster's totals; empty with "-" before any reading. */
export function UsageMeters({
  usage,
  className,
}: {
  usage: ServerUsage | null;
  className?: string;
}) {
  return (
    <div className={cn("space-y-3", className)}>
      <UsageMeter
        icon={Cpu}
        label="CPU"
        value={usage ? `${round(usage.cpu)}% of ${usage.cores} cores` : "-"}
        percent={usage?.cpu ?? 0}
      />
      <UsageMeter
        icon={MemoryStick}
        label="Memory"
        value={
          usage
            ? `${formatBytes(usage.memUsed)} of ${formatBytes(usage.memTotal)}`
            : "-"
        }
        percent={usage ? pct(usage.memUsed, usage.memTotal) : 0}
      />
      <UsageMeter
        icon={HardDrive}
        label="Disk"
        value={
          usage
            ? `${formatBytes(usage.diskUsed)} of ${formatBytes(usage.diskTotal)}`
            : "-"
        }
        percent={usage ? pct(usage.diskUsed, usage.diskTotal) : 0}
      />
    </div>
  );
}
