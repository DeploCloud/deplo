import { notFound } from "next/navigation";
import Link from "@/components/ui/link";
import { ArrowLeft } from "lucide-react";

import { DeploMark } from "@/components/logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getServerById, serverRole } from "@/lib/data/servers/roster";
import { getServerTeamIds } from "@/lib/data/servers/team-access";
import { listAllTeamsForAdmin } from "@/lib/data/teams";
import { getCleanupPolicy } from "@/lib/data/docker-cleanup/policy";
import { listCleanupRuns } from "@/lib/data/docker-cleanup/run-history";
import { isInstanceAdmin } from "@/lib/membership";
import { hydrateServerSpecs } from "@/lib/data/monitoring";
import {
  deploHostSelfAddresses,
  isBuildFallbackServer,
  isDeploHostServer,
} from "@/lib/deploy/domains";
import { serverLabel } from "@/lib/utils";
import { reportedAgentVersion, agentUpdateAvailable } from "@/lib/version";
import { expectedAgentVersionFor } from "@/lib/agent/release";
import type { TeamOption } from "@/components/servers/server-team-access";
import {
  ServerHealthProvider,
  type ServerHealthState,
} from "../server-health-provider";
import { ServerHealthChip } from "../server-health-chip";
import { CheckStatusButton } from "../check-status-button";
import { ServerDetailTabs } from "./server-detail-tabs";
import { titleClass } from "@/components/shared/page-header";

export async function generateMetadata(
  props: PageProps<"/[team]/settings/servers/[id]">,
) {
  const { id } = await props.params;
  const server = await getServerById(id).catch(() => null);
  return { title: server ? `${serverLabel(server)} · Servers` : "Server" };
}

export default async function ServerDetailPage(
  props: PageProps<"/[team]/settings/servers/[id]">,
) {
  if (!(await isInstanceAdmin())) notFound();

  const { id } = await props.params;
  const server = await getServerById(id);
  if (!server) notFound();
  if (server.importOnly) notFound();

  const [expectedAgentVersion, teamIds, teamsRaw, policy, runs] =
    await Promise.all([
      expectedAgentVersionFor(server),
      getServerTeamIds(id),
      listAllTeamsForAdmin(),
      getCleanupPolicy(),
      listCleanupRuns({ serverId: id }),
    ]);

  const [hydrated] = await hydrateServerSpecs([server]);
  const self = deploHostSelfAddresses();
  const isDeploHost = isDeploHostServer(server, self);
  const teams: TeamOption[] = teamsRaw.map((t) => ({
    id: t.id,
    name: t.name,
    avatarUrl: t.avatarUrl,
  }));
  const agentVersion = reportedAgentVersion(hydrated);

  const seed: Record<string, ServerHealthState> = {
    [server.id]: {
      status: server.status,
      checkedAt: server.statusCheckedAt ?? null,
      message: server.statusMessage ?? null,
      traefikEnabled: server.traefikEnabled,
      lastReachedAt: server.lastSeenAt ?? null,
    },
  };

  return (
    <ServerHealthProvider seed={seed}>
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <div className="space-y-3">
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2 h-8 text-muted-foreground"
            asChild
          >
            <Link href="/settings/servers">
              <ArrowLeft className="size-4" />
              Servers
            </Link>
          </Button>
          <div className="flex items-center gap-2">
            <h1
              className={`${titleClass.page} min-w-0 truncate`}
              title={serverLabel(hydrated)}
            >
              {serverLabel(hydrated)}
            </h1>
            <span className="shrink-0">
              <ServerHealthChip
                serverId={server.id}
                fallback={seed[server.id]}
              />
            </span>
            {isDeploHost && (
              <Badge className="shrink-0 gap-1 whitespace-nowrap">
                <DeploMark size={12} className="text-current" />
                Deplo host
              </Badge>
            )}
            <div className="ml-auto shrink-0">
              <CheckStatusButton
                serverId={server.id}
                serverName={serverLabel(hydrated)}
              />
            </div>
          </div>
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            {hydrated.ip}
          </p>
        </div>

        <ServerDetailTabs
          server={{
            id: hydrated.id,
            name: serverLabel(hydrated),
            ip: hydrated.ip,
            host: hydrated.host,
            agentPort: hydrated.agent?.port ?? null,
            status: hydrated.status,
            cpuCores: hydrated.cpuCores,
            memoryMb: hydrated.memoryMb,
            diskGb: hydrated.diskGb,
            dockerVersion: hydrated.dockerVersion,
            allTeams: hydrated.allTeams,
            deployConcurrency: hydrated.deployConcurrency,
            role: serverRole(hydrated) as "everything" | "build" | "storage",
            buildFallback: isBuildFallbackServer(hydrated, self),
            isDeploHost,
            provisioning: hydrated.status === "provisioning",
            agentVersion,
            agentCanary: hydrated.agentCanary,
            expectedAgentVersion,
            agentUpdateAvailable: agentUpdateAvailable(
              agentVersion,
              expectedAgentVersion,
            ),
          }}
          teams={teams}
          accessTeamIds={teamIds}
          cleanup={{
            policy,
            runs,
          }}
        />
      </div>
    </ServerHealthProvider>
  );
}
