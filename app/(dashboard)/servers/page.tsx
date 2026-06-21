import { Network, Server as ServerIcon } from "lucide-react";

import { PageHeader } from "@/components/shared/page-header";
import { StatusDot } from "@/components/shared/status-badge";
import { EmptyState } from "@/components/shared/empty-state";
import { AddServer } from "@/components/servers/add-server";
import { ServerActions } from "@/components/servers/server-actions";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { listServers } from "@/lib/data/servers";
import { getInitialServerMetrics } from "@/lib/data/monitoring";
import { serverLabel } from "@/lib/utils";
import type { Server } from "@/lib/types";
import { ServerMetricsProvider, LiveServerMetrics } from "./server-metrics";

export const metadata = { title: "Servers" };

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
          {/* Management actions for remote servers only — the master isn't
              provisioned via bootstrap and can't be removed. Pushed to the right. */}
          {server.type === "remote" && (
            <div className="ml-auto">
              <ServerActions
                serverId={server.id}
                serverName={serverLabel(server)}
                provisioning={server.status === "provisioning"}
              />
            </div>
          )}
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
        <LiveServerMetrics
          serverId={server.id}
          fallback={{
            cpu: server.cpuUsage,
            memPct: server.memoryUsage,
            diskPct: server.diskUsage,
          }}
          cpuCores={server.cpuCores}
          memoryGb={Number((server.memoryMb / 1024).toFixed(0))}
          diskGb={server.diskGb}
        />
      </CardContent>
    </Card>
  );
}

export default async function ServersPage() {
  // Cheap last-known metrics so the page renders instantly; the cards poll live
  // values every second and replace these (see ServerMetricsProvider).
  const [servers, allMetrics] = await Promise.all([
    listServers(),
    getInitialServerMetrics(),
  ]);

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
              Register a remote Linux host, then run the one-time install command
              it gives you on the server. The agent calls home and provisions
              itself — Deplo never needs SSH access to your box.
            </CardDescription>
          </div>
          <AddServer />
        </CardHeader>
      </Card>

      {servers.length === 0 ? (
        <EmptyState
          icon={ServerIcon}
          title="No servers connected"
          description="Run the install command above on a Linux host to add your first server."
        />
      ) : (
        <ServerMetricsProvider initialMetrics={allMetrics}>
          <div className="grid gap-4 sm:grid-cols-2">
            {servers.map((server) => (
              <ServerCard key={server.id} server={server} />
            ))}
          </div>
        </ServerMetricsProvider>
      )}
    </div>
  );
}
