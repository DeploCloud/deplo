import { headers } from "next/headers";
import { Cpu, MemoryStick, HardDrive, Network, Server as ServerIcon } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { StatusDot } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { CommandLine } from "@/components/shared/code-block";
import { AddServer } from "@/components/servers/add-server";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { listServers } from "@/lib/data/servers";
import { resolvePublicBaseUrl } from "@/lib/public-url";
import { serverLabel } from "@/lib/utils";
import type { Server } from "@/lib/types";

export const metadata = { title: "Servers" };

function usageTone(value: number): string | undefined {
  if (value >= 90) return "bg-destructive";
  if (value >= 75) return "bg-[var(--warning)]";
  return undefined;
}

function Metric({
  icon: Icon,
  label,
  value,
  caption,
}: {
  icon: typeof Cpu;
  label: string;
  value: number;
  caption: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-4" />
          {label}
        </span>
        <span className="font-mono tabular-nums">{value}%</span>
      </div>
      <Progress value={value} indicatorClassName={usageTone(value)} />
      <p className="text-xs text-muted-foreground">{caption}</p>
    </div>
  );
}

function ServerCard({ server }: { server: Server }) {
  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center gap-2">
          <StatusDot status={server.status} />
          <CardTitle className="truncate">{serverLabel(server)}</CardTitle>
          <Badge variant={server.type === "localhost" ? "default" : "secondary"}>
            {server.type === "localhost" ? "master" : "remote"}
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className="font-mono text-muted-foreground">{server.ip}</span>
          <span className="text-muted-foreground">
            Docker {server.dockerVersion}
          </span>
          <Badge variant={server.traefikEnabled ? "success" : "muted"}>
            <Network className="size-3" />
            Traefik {server.traefikEnabled ? "on" : "off"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Metric
          icon={Cpu}
          label="CPU"
          value={server.cpuUsage}
          caption={`${server.cpuCores} cores`}
        />
        <Metric
          icon={MemoryStick}
          label="Memory"
          value={server.memoryUsage}
          caption={`${(server.memoryMb / 1024).toFixed(0)} GB RAM`}
        />
        <Metric
          icon={HardDrive}
          label="Disk"
          value={server.diskUsage}
          caption={`${server.diskGb} GB disk`}
        />
      </CardContent>
    </Card>
  );
}

export default async function ServersPage() {
  const servers = await listServers();

  const base = resolvePublicBaseUrl(await headers());

  return (
    <div className="space-y-6">
      <PageHeader
        title="Servers"
        description="Connected Docker hosts running your deployments."
      />

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Add a server</CardTitle>
            <CardDescription>
              Connect a remote Linux server over SSH, or run the install command
              on it. Deplo sets up Docker and Traefik automatically, with no
              manual configuration.
            </CardDescription>
          </div>
          <AddServer installCommand={`curl -fsSL ${base}/install | bash`} />
        </CardHeader>
        <CardContent>
          <CommandLine command={`curl -fsSL ${base}/install | bash`} />
        </CardContent>
      </Card>

      {servers.length === 0 ? (
        <EmptyState
          icon={ServerIcon}
          title="No servers connected"
          description="Run the install command above on a Linux host to add your first server."
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {servers.map((server) => (
            <ServerCard key={server.id} server={server} />
          ))}
        </div>
      )}
    </div>
  );
}
