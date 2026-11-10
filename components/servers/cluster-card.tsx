import { Suspense } from "react";
import { Network } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Bone } from "@/components/ui/skeleton";
import { getClusterLeader } from "@/lib/data/clusters/leader";
import type { Cluster, ClusterLeader } from "@/lib/types/cluster";
import { ClusterActions, StartLeaderButton } from "./cluster-actions";
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
        <p className="text-sm text-muted-foreground">No servers yet.</p>
        <Suspense
          fallback={<Bone>Leader runs on Deplo machine Answering</Bone>}
        >
          <LeaderLine clusterId={cluster.id} />
        </Suspense>
      </CardContent>
    </Card>
  );
}
