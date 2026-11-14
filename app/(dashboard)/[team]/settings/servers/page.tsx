import { notFound } from "next/navigation";
import { Server as ServerIcon } from "lucide-react";

import { AutoRefresh } from "@/components/shared/auto-refresh";
import { EmptyState } from "@/components/shared/empty-state";
import { AddServer } from "@/components/servers/add-server";
import type { ClusterCardData } from "@/components/servers/cluster-card";
import {
  memberState,
  type ClusterJoinOption,
} from "@/components/servers/cluster-join";
import { ClusterPanel } from "@/components/servers/cluster-panel";
import { serverUse } from "@/components/servers/server-role-badge";
import { listAllServers } from "@/lib/data/servers/roster";
import { listAllServerTeamIds } from "@/lib/data/servers/team-access";
import {
  listClusterJoinCandidates,
  listClusterMembers,
} from "@/lib/data/clusters/members";
import {
  listAllClusterTeamIds,
  listAllClusters,
} from "@/lib/data/clusters/roster";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "@/lib/deploy/domains";
import { listAllTeamsForAdmin } from "@/lib/data/teams";
import { isInstanceAdmin } from "@/lib/membership";
import { hydrateServerSpecs } from "@/lib/data/monitoring";
import { failoverOn } from "@/lib/types/cluster";
import { serverLabel } from "@/lib/utils";
import {
  AGENT_VERSION,
  agentReach,
  reportedAgentVersion,
  type AgentReach,
} from "@/lib/version";
import { offlineAdvice } from "@/lib/data/server-health";
import type { Server } from "@/lib/types/server";
import type { TeamOption } from "@/components/servers/server-team-access";
import type { ServerCardData, ServerSpecs } from "./server-card";
import { ServersGrid } from "./servers-grid";
import { ServersHeader } from "./servers-shell";
import {
  ServerHealthProvider,
  type ServerHealthState,
} from "./server-health-provider";
import { RefreshFleetButton } from "./check-status-button";

export const metadata = { title: "Servers" };

const first = (v: string | string[] | undefined) =>
  Array.isArray(v) ? v[0] : v;

const healthOf = (s: Server): ServerHealthState => ({
  status: s.status,
  checkedAt: s.statusCheckedAt ?? null,
  message: s.statusMessage ?? null,
  traefikEnabled: s.traefikEnabled,
  lastReachedAt: s.lastSeenAt ?? null,
});

const specsOf = (s: Server): ServerSpecs => ({
  cpuCores: s.cpuCores,
  memoryMb: s.memoryMb,
  diskGb: s.diskGb,
  dockerVersion: s.dockerVersion ?? "",
});

export default async function ServersPage(
  props: PageProps<"/[team]/settings/servers">,
) {
  if (!(await isInstanceAdmin())) notFound();

  const params = await props.searchParams;
  const autoOpenServer = first(params.new) === "1";
  const view = first(params.view) === "list" ? "list" : "grid";

  const [serversRaw, serverTeamIds, teamsRaw, clusters, clusterTeamIds] =
    await Promise.all([
      listAllServers().then((all) => all.filter((s) => !s.importOnly)),
      listAllServerTeamIds(),
      listAllTeamsForAdmin(),
      listAllClusters(),
      listAllClusterTeamIds(),
    ]);
  const measured = hydrateServerSpecs(serversRaw)
    .catch(() => serversRaw)
    .then((list) => new Map(list.map((s) => [s.id, s])));
  const specsFor = (server: Server) =>
    (server.cpuCores > 0
      ? Promise.resolve(server)
      : measured.then((m) => m.get(server.id) ?? server)
    ).then(specsOf);
  const teams: TeamOption[] = teamsRaw.map((t) => ({
    id: t.id,
    name: t.name,
    avatarUrl: t.avatarUrl,
  }));

  const selfAddrs = deploHostSelfAddresses();
  const servers = [...serversRaw].sort(
    (a, b) =>
      Number(isDeploHostServer(b, selfAddrs)) -
      Number(isDeploHostServer(a, selfAddrs)),
  );

  const clusterRows = await Promise.all(
    clusters.map(async (cluster) => {
      const [members, candidates] = await Promise.all([
        listClusterMembers(cluster.id),
        listClusterJoinCandidates(cluster.id),
      ]);
      const joinOptions: ClusterJoinOption[] = candidates.map((c) => ({
        serverId: c.serverId,
        serverName: c.serverName,
        blocked: c.reasons[0]?.message ?? "",
        apps: c.apps,
        databases: c.databases,
      }));
      return { cluster, members, joinOptions };
    }),
  );
  const memberOf = new Map(
    clusterRows.flatMap(({ cluster, members }) =>
      members.map((m, order) => [
        m.serverId,
        { cluster, member: m, order, servers: members.length },
      ]),
    ),
  );

  // Nothing to refuse until its agent has enrolled.
  const reachOf = (s: Server): AgentReach =>
    s.agent?.certFingerprint ? agentReach(s) : "usable";
  const advice = new Map(
    await Promise.all(
      servers.map(async (s) => [s.id, await offlineAdvice(s)] as const),
    ),
  );

  const teamRefs = new Map(
    teamsRaw.map((t) => [
      t.id,
      { slug: t.slug, name: t.name, avatarUrl: t.avatarUrl },
    ]),
  );
  const cards: ServerCardData[] = servers.map((server) => {
    const accessTeamIds = serverTeamIds.get(server.id) ?? [];
    const held = memberOf.get(server.id);
    return {
      id: server.id,
      name: serverLabel(server),
      ip: server.ip,
      search: [server.name, server.host, server.ip].join(" ").toLowerCase(),
      use: serverUse(server),
      teams: server.allTeams
        ? [...teamRefs.values()]
        : accessTeamIds.flatMap((id) => {
            const t = teamRefs.get(id);
            return t ? [t] : [];
          }),
      isDeploHost: isDeploHostServer(server, selfAddrs),
      accessLabel: server.allTeams
        ? "All teams"
        : `${accessTeamIds.length} team${accessTeamIds.length === 1 ? "" : "s"}`,
      agentVersion: reportedAgentVersion(server),
      expected: AGENT_VERSION,
      reach: reachOf(server),
      health: healthOf(server),
      advice: advice.get(server.id)!,
      specs: specsFor(server),
      uninstallPending: Boolean(server.uninstallPending),
      uninstallError: server.uninstallError ?? null,
      cluster: held
        ? {
            id: held.cluster.id,
            name: held.cluster.name,
            servers: held.servers,
          }
        : null,
      member: held ? memberState(held.member) : null,
    };
  });

  const open =
    clusterRows.find((r) => r.cluster.id === first(params.cluster)) ?? null;
  const clusterCards: ClusterCardData[] = clusterRows.map(
    ({ cluster, members, joinOptions }) => ({
      id: cluster.id,
      name: cluster.name,
      allTeams: cluster.allTeams,
      teamIds: clusterTeamIds.get(cluster.id) ?? [],
      servers: members.length,
      failoverOn: failoverOn(members.length),
      provisioning: members.filter((m) => m.provisioning).length,
      joinOptions,
    }),
  );
  // In the order they joined, as the cluster itself lists them.
  const openServers = open
    ? cards
        .filter((c) => c.cluster?.id === open.cluster.id)
        .sort((a, b) => memberOf.get(a.id)!.order - memberOf.get(b.id)!.order)
    : cards;

  const healthSeed: Record<string, ServerHealthState> = Object.fromEntries(
    servers.map((s) => [s.id, healthOf(s)]),
  );

  return (
    <ServerHealthProvider seed={healthSeed}>
      <div className="space-y-5">
        <ServersHeader
          actions={
            <>
              <RefreshFleetButton />
              <AddServer autoOpen={autoOpenServer} teams={teams} />
            </>
          }
        />

        {/* A server that is joining stops reading Provisioning on its own. */}
        <AutoRefresh
          active={!open && clusterCards.some((c) => c.provisioning > 0)}
        />

        {servers.length === 0 && clusters.length === 0 ? (
          <EmptyState
            icon={ServerIcon}
            title="No servers connected"
            docs="servers.add"
            description="Use Add above to register your first Linux host, then run the one-time install command it gives you on the box."
          />
        ) : (
          <ServersGrid
            servers={openServers}
            clusters={open ? [] : clusterCards}
            teams={teams}
            openCluster={
              open ? { id: open.cluster.id, name: open.cluster.name } : null
            }
            view={view}
            panel={
              open ? (
                <ClusterPanel
                  cluster={open.cluster}
                  members={open.members}
                  joinOptions={open.joinOptions}
                  teamIds={clusterTeamIds.get(open.cluster.id) ?? []}
                  teams={teams}
                />
              ) : undefined
            }
          />
        )}
      </div>
    </ServerHealthProvider>
  );
}
