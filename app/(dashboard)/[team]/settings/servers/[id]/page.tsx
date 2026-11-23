import { notFound } from "next/navigation";

import { DeploMark } from "@/components/logo";
import { Badge } from "@/components/ui/badge";
import { getServerById, serverRole } from "@/lib/data/servers/roster";
import { serverAddressViews } from "@/lib/data/servers/address-checks";
import { serverWildcardIp } from "@/lib/data/servers/addresses";
import { getServerTeamIds } from "@/lib/data/servers/team-access";
import { listServerWorkloads } from "@/lib/data/servers/workloads";
import { listAllTeamsForAdmin } from "@/lib/data/teams";
import { getCleanupPolicy } from "@/lib/data/docker-cleanup/policy";
import { listCleanupRuns } from "@/lib/data/docker-cleanup/run-history";
import { isInstanceAdmin } from "@/lib/membership";
import { hydrateServerSpecs } from "@/lib/data/monitoring";
import { isBuildFallbackServer, isDeploHostServer } from "@/lib/deploy/domains";
import { serverLabel } from "@/lib/utils";
import { AGENT_VERSION, agentReach, reportedAgentVersion } from "@/lib/version";
import { serverAgentUpdate } from "@/lib/data/servers/agent-maintenance";
import { offlineAdvice } from "@/lib/data/server-health";
import type { TeamOption } from "@/components/servers/server-team-access";
import {
  ServerHealthProvider,
  type ServerHealthState,
} from "../server-health-provider";
import {
  clusterOfServer,
  listClusterMembers,
} from "@/lib/data/clusters/members";
import { lineWords } from "@/components/servers/cluster-join";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { Crown, TriangleAlert } from "lucide-react";
import { ServerHealthChip } from "../server-health-chip";
import { CheckStatusButton } from "../check-status-button";
import { ServerDetailTabs } from "./server-detail-tabs";
import { ServerDetailHeader } from "./server-detail-header";
import { ServerClusterState } from "./server-cluster-state";
import { LeftByAnotherDeploNote } from "./left-by-another-deplo";
import { leftByAnotherDeplo } from "@/lib/data/servers/panel-claim";

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

  const memberOf = await clusterOfServer(id);
  const asMember = memberOf
    ? (await listClusterMembers(memberOf.id)).find((m) => m.serverId === id)
    : undefined;
  const leftByAnother = leftByAnotherDeplo(id);
  const expectedAgentVersion = AGENT_VERSION;
  const [
    teamIds,
    teamsRaw,
    policy,
    runs,
    workloads,
    agentUpdate,
    advice,
    initialAddresses,
    initialPrimaryAddress,
  ] = await Promise.all([
    getServerTeamIds(id),
    listAllTeamsForAdmin(),
    getCleanupPolicy(),
    listCleanupRuns({ serverId: id }),
    listServerWorkloads(id),
    serverAgentUpdate(id),
    offlineAdvice(server),
    serverAddressViews(id),
    serverWildcardIp(server).catch(() => null),
  ]);

  const [hydrated] = await hydrateServerSpecs([server]);
  const isDeploHost = isDeploHostServer(server);
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
        <ServerDetailHeader
          name={serverLabel(hydrated)}
          title={serverLabel(hydrated)}
          badges={
            <>
              <span className="shrink-0">
                <ServerHealthChip
                  serverId={server.id}
                  fallback={seed[server.id]}
                  offlineAdvice={advice}
                />
              </span>
              {memberOf && (
                <Badge variant="muted" className="shrink-0 whitespace-nowrap">
                  Member of cluster {memberOf.name}
                </Badge>
              )}
              {asMember && lineWords(asMember.nextInLine) && (
                <SimpleTooltip content={lineWords(asMember.nextInLine)}>
                  <Badge
                    variant="muted"
                    className="shrink-0 gap-1 whitespace-nowrap"
                  >
                    <Crown className="size-3" />
                    {asMember.nextInLine === 1
                      ? "Next in line"
                      : "Second in line"}
                  </Badge>
                </SimpleTooltip>
              )}
              {asMember?.relayWarning && (
                <SimpleTooltip content={asMember.relayWarning}>
                  <Badge
                    variant="warning"
                    className="shrink-0 gap-1 whitespace-nowrap"
                  >
                    <TriangleAlert className="size-3" />
                    Needs Deplo&apos;s relay
                  </Badge>
                </SimpleTooltip>
              )}
              {isDeploHost && (
                <Badge className="shrink-0 gap-1 whitespace-nowrap">
                  <DeploMark size={12} className="text-current" />
                  Deplo host
                </Badge>
              )}
            </>
          }
          action={
            <CheckStatusButton
              serverId={server.id}
              serverName={serverLabel(hydrated)}
            />
          }
          ip={hydrated.ip}
          connectedFrom={isDeploHost ? null : (server.connectedFrom ?? null)}
        />
        {leftByAnother && <LeftByAnotherDeploNote state={leftByAnother} />}
        {memberOf && (
          <ServerClusterState
            serverId={server.id}
            dropAfterMs={memberOf.dnsDropAfter * 1000}
          />
        )}

        <ServerDetailTabs
          server={{
            id: hydrated.id,
            name: serverLabel(hydrated),
            ip: hydrated.ip,
            host: hydrated.host,
            status: hydrated.status,
            cpuCores: hydrated.cpuCores,
            memoryMb: hydrated.memoryMb,
            diskGb: hydrated.diskGb,
            dockerVersion: hydrated.dockerVersion,
            allTeams: hydrated.allTeams,
            deployConcurrency: hydrated.deployConcurrency,
            role: serverRole(hydrated) as "everything" | "build" | "storage",
            buildFallback: isBuildFallbackServer(hydrated),
            generatedAddressFamily: hydrated.generatedAddressFamily,
            preferredAddress: hydrated.preferredAddress ?? null,
            initialAddresses,
            initialPrimaryAddress,
            isDeploHost,
            provisioning: hydrated.status === "provisioning",
            agentVersion,
            expectedAgentVersion,
            // Nothing to refuse until its agent has enrolled.
            agentReach: hydrated.agent?.certFingerprint
              ? agentReach(hydrated)
              : "usable",
            agentUpdate,
            clusterName: memberOf?.name ?? null,
          }}
          teams={teams}
          accessTeamIds={teamIds}
          cleanup={{
            policy,
            runs,
          }}
          workloads={workloads}
        />
      </div>
    </ServerHealthProvider>
  );
}
