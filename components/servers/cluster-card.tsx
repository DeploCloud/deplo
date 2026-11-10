import { Suspense } from "react";
import { Network } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bone } from "@/components/ui/skeleton";
import { getClusterLeader } from "@/lib/data/clusters/leader";
import {
  listClusterJoinCandidates,
  listClusterMembers,
} from "@/lib/data/clusters/members";
import {
  failoverOn,
  type Cluster,
  type ClusterLeader,
} from "@/lib/types/cluster";
import type { ServerStatus } from "@/lib/types/server";
import {
  ClusterActions,
  JoinClusterButton,
  StartLeaderButton,
} from "./cluster-actions";
import type { TeamOption } from "./server-team-access";

const LEADER_BADGE: Record<
  ClusterLeader["state"],
  { label: string; variant: "success" | "warning" | "destructive" }
> = {
  running: { label: "Answering", variant: "success" },
  stopped: { label: "Not running", variant: "warning" },
  not_installed: { label: "Not started", variant: "warning" },
  unreachable: { label: "Not reachable", variant: "destructive" },
  unavailable: { label: "Can't start", variant: "warning" },
};

const MEMBER_BADGE: Record<
  ServerStatus,
  { label: string; variant: "success" | "warning" | "destructive" }
> = {
  online: { label: "Online", variant: "success" },
  warning: { label: "Degraded", variant: "warning" },
  error: { label: "Error", variant: "destructive" },
  offline: { label: "Offline", variant: "destructive" },
  provisioning: { label: "Provisioning", variant: "warning" },
};

async function Members({ clusterId }: { clusterId: string }) {
  const [members, candidates] = await Promise.all([
    listClusterMembers(clusterId),
    listClusterJoinCandidates(clusterId),
  ]);
  const options = candidates.map((c) => ({
    serverId: c.serverId,
    serverName: c.serverName,
    blocked: c.reasons[0]?.message ?? "",
  }));
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">
          {members.length === 0
            ? "No servers yet."
            : `${members.length} server${members.length === 1 ? "" : "s"}`}
        </span>
        {failoverOn(members.length) ? (
          <Badge variant="success">Failover on</Badge>
        ) : (
          members.length > 0 && (
            <span className="text-xs text-muted-foreground">
              Failover starts at two servers.
            </span>
          )
        )}
        <div className="ml-auto">
          <JoinClusterButton clusterId={clusterId} options={options} />
        </div>
      </div>
      {members.length > 0 && (
        <ul className="space-y-1">
          {members.map((m) => (
            <li key={m.serverId} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 truncate font-medium">
                {m.serverName}
              </span>
              <Badge variant={MEMBER_BADGE[m.status].variant}>
                {MEMBER_BADGE[m.status].label}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function LeaderLine({ clusterId }: { clusterId: string }) {
  const leader = await getClusterLeader(clusterId);
  const badge = LEADER_BADGE[leader.state];
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Leader runs on</span>
        <span className="font-medium">{leader.serverName}</span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        {leader.state !== "running" && leader.state !== "unavailable" && (
          <StartLeaderButton clusterId={clusterId} />
        )}
      </div>
      {leader.message && (
        <p className="text-xs text-muted-foreground">{leader.message}</p>
      )}
    </div>
  );
}

export function ClusterCard({
  cluster,
  teamIds,
  teams,
}: {
  cluster: Cluster;
  teamIds: string[];
  teams: TeamOption[];
}) {
  const access = cluster.allTeams
    ? "All teams"
    : `${teamIds.length} team${teamIds.length === 1 ? "" : "s"}`;
  return (
    <Card>
      <CardHeader className="space-y-3">
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Network className="size-4 shrink-0 text-muted-foreground" />
            <CardTitle className="min-w-0 truncate" title={cluster.name}>
              {cluster.name}
            </CardTitle>
            <Badge variant="muted" title="Which teams can use this cluster">
              {access}
            </Badge>
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <ClusterActions
              cluster={{
                id: cluster.id,
                name: cluster.name,
                allTeams: cluster.allTeams,
                teamIds,
              }}
              teams={teams}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Suspense fallback={<Bone>2 servers Failover on</Bone>}>
          <Members clusterId={cluster.id} />
        </Suspense>
        <Suspense
          fallback={<Bone>Leader runs on Deplo machine Answering</Bone>}
        >
          <LeaderLine clusterId={cluster.id} />
        </Suspense>
      </CardContent>
    </Card>
  );
}
