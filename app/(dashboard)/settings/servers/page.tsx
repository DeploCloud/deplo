import { Server as ServerIcon } from "lucide-react";

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
import {
  isAgentOutdated,
  reportedAgentVersion,
  resolveExpectedAgentVersion,
} from "@/lib/version";
import type { Server } from "@/lib/types";
import { AgentVersionBadge } from "./agent-version-badge";
import { CheckUpdatesButton } from "./check-updates-button";
import {
  ServerMetricsProvider,
  LiveServerMetrics,
  LiveTraefikBadge,
} from "./server-metrics";

export const metadata = { title: "Servers" };

function ServerCard({
  server,
  expectedAgentVersion,
}: {
  server: Server;
  expectedAgentVersion: string;
}) {
  const agentVersion = reportedAgentVersion(server);
  const outdated = isAgentOutdated(agentVersion, expectedAgentVersion);
  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-center gap-2">
          <StatusDot status={server.status} />
          <CardTitle className="truncate">{serverLabel(server)}</CardTitle>
          <Badge variant="secondary">{server.status}</Badge>
          {/* Every server is a bootstrapped agent now (the host running Deplo
              included), so the management actions apply to all of them. */}
          <div className="ml-auto">
            <ServerActions
              serverId={server.id}
              serverName={serverLabel(server)}
              provisioning={server.status === "provisioning"}
              outdated={outdated}
              expectedVersion={expectedAgentVersion}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          <span className="font-mono text-muted-foreground">{server.ip}</span>
          <span className="text-muted-foreground">
            Docker {server.dockerVersion}
          </span>
          <LiveTraefikBadge
            serverId={server.id}
            initial={server.traefikEnabled}
          />
          <AgentVersionBadge
            version={agentVersion}
            expected={expectedAgentVersion}
            outdated={outdated}
          />
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
  const [servers, allMetrics, expectedAgentVersion] = await Promise.all([
    listServers(),
    getInitialServerMetrics(),
    resolveExpectedAgentVersion(),
  ]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Servers"
        description="Connected Docker hosts running your deployments."
        actions={<CheckUpdatesButton />}
      />

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1.5">
            <CardTitle>Add a server</CardTitle>
            <CardDescription>
              Start with <strong>this host</strong>: add it (use its IP), then run
              the one-time install command it gives you here on the box to install
              the agent. Add more Linux hosts the same way. The agent calls home and
              provisions itself — Deplo never needs SSH access to your servers.
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
              <ServerCard
                key={server.id}
                server={server}
                expectedAgentVersion={expectedAgentVersion}
              />
            ))}
          </div>
        </ServerMetricsProvider>
      )}
    </div>
  );
}
