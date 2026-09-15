import * as React from "react";
import Link from "@/components/ui/link";
import { Archive, HardDrive } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { StatusDot } from "@/components/shared/status-badge";
import { ScheduleLabel } from "@/components/shared/schedule-picker";
import { formatBytes, timeAgoShort, cn } from "@/lib/utils";
import type { DatabaseBackupSummary } from "@/lib/data/backups/run-listing";
import type { ContainerMetrics } from "@/lib/data/container-metrics";
import type { DatabaseDTO } from "@/lib/data/databases/rows";

export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  href?: string;
}) {
  const body = (
    <CardContent className="space-y-1 p-4">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" />
        {label}
      </p>
      <p className="text-sm font-medium">{value}</p>
      {sub != null && (
        <div className="text-xs text-muted-foreground">{sub}</div>
      )}
    </CardContent>
  );
  return (
    <Card className={cn(href && "transition-colors hover:bg-surface")}>
      {href ? <Link href={href}>{body}</Link> : body}
    </Card>
  );
}

// `bytes === null` means the agent cannot answer yet: a dash, never a zero that reads as empty.
export function DataStat({
  db,
  metrics,
  bytes,
  href,
}: {
  db: DatabaseDTO;
  metrics: ContainerMetrics | null;
  bytes: number | null | undefined;
  href: string;
}) {
  // Docker reports the HOST's RAM as the limit when nothing caps the container, so use the stored cap.
  const capMb = db.resources?.memoryMb ?? null;
  const ram =
    metrics?.online && metrics.memUsed > 0
      ? `${formatBytes(metrics.memUsed)}${capMb ? ` / ${formatBytes(capMb * 1024 * 1024)}` : ""} RAM`
      : null;

  return (
    <StatCard
      icon={HardDrive}
      label="Data"
      value={
        bytes == null ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          formatBytes(bytes)
        )
      }
      sub={
        <>
          <p>on disk</p>
          {ram && <p className="mt-1">{ram}</p>}
        </>
      }
      href={href}
    />
  );
}

export function BackupsStat({
  summary,
  href,
}: {
  summary: DatabaseBackupSummary;
  href?: string;
}) {
  const { schedules, lastRunAt, lastStatus } = summary;
  const one = schedules.length === 1 ? schedules[0] : null;

  return (
    <StatCard
      icon={Archive}
      label="Backups"
      value={
        lastRunAt ? (
          <span className="flex items-center gap-1.5">
            {lastStatus && <StatusDot status={lastStatus} />}
            {timeAgoShort(lastRunAt)}
          </span>
        ) : schedules.length ? (
          "Never run"
        ) : (
          <span className="text-muted-foreground">Not backed up</span>
        )
      }
      sub={
        one ? (
          <ScheduleLabel cron={one.schedule} timezone={one.timezone} />
        ) : schedules.length ? (
          `${schedules.length} schedules`
        ) : (
          "No schedule"
        )
      }
      href={href}
    />
  );
}
