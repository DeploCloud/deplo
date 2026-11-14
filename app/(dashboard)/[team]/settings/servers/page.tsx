import { Suspense } from "react";
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
import { ClusterBar } from "@/components/servers/cluster-bar";
import { ClusterNotices } from "@/components/servers/cluster-panel";
import {
  loadClusterWarnings,
  storedClusterWarnings,
} from "@/lib/data/clusters/warnings";
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
import { leaderHostOf } from "@/lib/data/clusters/host";
import { listClusterLeaderChoices } from "@/lib/data/clusters/leader-move";
import {
  deploHostSelfAddresses,
  isDeploHostServer,
} from "@/lib/deploy/domains";
import { listAllTeamsForAdmin } from "@/lib/data/teams";
import { isInstanceAdmin } from "@/lib/membership";
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
import type { ServerCardData } from "./server-card";
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
      const [members, candidates, leader] = await Promise.all([
        listClusterMembers(cluster.id),
        listClusterJoinCandidates(cluster.id),
        // Where it was put: Deplo's machine standing in is one of the cluster's warnings.
        leaderHostOf(cluster.leaderServerId).catch(() => null),
      ]);
      const joinOptions: ClusterJoinOption[] = candidates.map((c) => ({
        serverId: c.serverId,
        serverName: c.serverName,
        blocked: c.reasons[0]?.message ?? "",
        apps: c.apps,
        databases: c.databases,
      }));
      return { cluster, members, joinOptions, leaderId: leader?.id ?? null };
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
      leader: Boolean(
        held &&
        clusterRows.find((r) => r.cluster.id === held.cluster.id)?.leaderId ===
          server.id,
      ),
    };
  });

  const open =
    clusterRows.find((r) => r.cluster.id === first(params.cluster)) ?? null;
  const stored = await storedClusterWarnings(clusters.map((c) => c.id));
  const warningsOf = new Map(
    clusterRows.map(({ cluster, members }) => [
      cluster.id,
      loadClusterWarnings(
        cluster,
        members.length,
        stored.get(cluster.id) ?? [],
      ),
    ]),
  );
  const clusterCards: ClusterCardData[] = clusterRows.map(
    ({ cluster, members, joinOptions }) => ({
      id: cluster.id,
      name: cluster.name,
      allTeams: cluster.allTeams,
      teamIds: clusterTeamIds.get(cluster.id) ?? [],
      servers: members.length,
      failoverEnabled: cluster.failoverEnabled,
      provisioning: members.filter((m) => m.provisioning).length,
      joinOptions,
      warnings: warningsOf.get(cluster.id)!,
    }),
  );
  // In the order they joined, as the cluster itself lists them.
  const openServers = open
    ? cards
        .filter((c) => c.cluster?.id === open.cluster.id)
        .sort((a, b) => memberOf.get(a.id)!.order - memberOf.get(b.id)!.order)
    : cards;

  const leaderChoices = open
    ? await listClusterLeaderChoices(open.cluster.id).catch(() => [])
    : [];
  // A server joining or leaving changes on its own: the page follows it.
  const changing = open
    ? open.members.some(
        (m) => m.provisioning || (m.emptying && !m.emptying.error),
      )
    : clusterCards.some((c) => c.provisioning > 0);

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

        <AutoRefresh active={changing} />

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
            leaderChoices={leaderChoices}
            panel={
              open ? (
                <Suspense fallback={null}>
                  <ClusterNotices
                    clusterId={open.cluster.id}
                    warnings={warningsOf.get(open.cluster.id)!}
                  />
                </Suspense>
              ) : undefined
            }
            bar={
              open ? (
                <ClusterBar
                  cluster={{
                    id: open.cluster.id,
                    name: open.cluster.name,
                    allTeams: open.cluster.allTeams,
                    teamIds: clusterTeamIds.get(open.cluster.id) ?? [],
                    failoverEnabled: open.cluster.failoverEnabled,
                  }}
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
