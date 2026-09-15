"use client";

import * as React from "react";
import { Cpu, RefreshCw } from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { HostUnavailable } from "@/components/servers/host-unavailable";
import { formatBytes } from "@/lib/utils";
import type { HostInfo } from "./host-info";

function Detail({
  label,
  value,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border py-2 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right font-mono text-sm">{value}</span>
    </div>
  );
}

export function HostDetails({
  info,
  loading,
  error,
  onRetry,
}: {
  info: HostInfo | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Cpu className="size-4" />
            Host details
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            What this machine is running, read from the server just now.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onRetry} disabled={loading}>
          <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {loading && !info ? (
          <div className="space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-8 animate-pulse rounded bg-surface-strong"
              />
            ))}
          </div>
        ) : error ? (
          <HostUnavailable what="Host details" reason={error} />
        ) : info ? (
          <div className="grid gap-x-8 sm:grid-cols-2">
            <div>
              <Detail
                label="Processor"
                value={
                  info.cpuModel
                    ? `${info.cpuCores} core${info.cpuCores === 1 ? "" : "s"} · ${info.cpuModel}`
                    : `${info.cpuCores} core${info.cpuCores === 1 ? "" : "s"}`
                }
              />
              <Detail
                label="Threads"
                value={info.cpuThreads > 0 ? String(info.cpuThreads) : "—"}
              />
              <Detail label="Memory" value={formatBytes(info.memTotalBytes)} />
              <Detail
                label="Disk"
                value={`${formatBytes(info.diskUsedBytes)} of ${formatBytes(info.diskTotalBytes)} used`}
              />
              <Detail label="Uptime" value={formatUptime(info.uptimeSec)} />
            </div>
            <div>
              <Detail label="Operating system" value={info.osPretty || "—"} />
              <Detail label="Kernel" value={info.kernel || "—"} />
              <Detail label="Architecture" value={info.arch || "—"} />
              <Detail label="Docker" value={info.dockerVersion || "—"} />
              <Detail
                label={
                  <span className="flex items-center gap-1">
                    Docker data
                    <InfoTip
                      content="Where images and volumes are stored. On a server with a separate data disk this is not the main filesystem."
                      docs="servers.advanced"
                    />
                  </span>
                }
                value={info.dockerRootDir || "—"}
              />
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function formatUptime(sec: number): string {
  if (sec <= 0) return "—";
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const mins = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}
