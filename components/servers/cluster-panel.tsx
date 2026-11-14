import { Suspense } from "react";
import { Network } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DocsLink } from "@/components/ui/docs-link";
import { Bone } from "@/components/ui/skeleton";
import { AutoRefresh } from "@/components/shared/auto-refresh";
import { TWO_SERVERS_NOTE } from "@/lib/clusters/failover-reach";
import { listClusterImageProgress } from "@/lib/data/clusters/images";
import { getClusterLeader } from "@/lib/data/clusters/leader";
import { listClusterLeaderChoices } from "@/lib/data/clusters/leader-move";
import { listClusterWaiting } from "@/lib/data/clusters/placement";
import {
  FAILOVER_MIN_MEMBERS,
  failoverOn,
  type Cluster,
  type ClusterLeader,
  type ClusterLeaderChoice,
  type ClusterMember,
} from "@/lib/types/cluster";
import {
  JoinClusterButton,
  MoveLeaderButton,
  StartLeaderButton,
} from "./cluster-actions";
import { ClusterHeaderActions } from "./cluster-delete";
import type { ClusterJoinOption } from "./cluster-join";
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
  outdated: { label: "Needs an update", variant: "warning" },
};

// The second line under the server count: what failover needs at this size.
export function FailoverNote({ servers }: { servers: number }) {
  if (servers !== FAILOVER_MIN_MEMBERS) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {TWO_SERVERS_NOTE} <DocsLink topic="clusters.leader" />
    </p>
  );
}

function Summary({
  cluster,
  members,
  joinOptions,
}: {
  cluster: Cluster;
  members: ClusterMember[];
  joinOptions: ClusterJoinOption[];
}) {
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
          <JoinClusterButton
            clusterId={cluster.id}
            clusterName={cluster.name}
            options={joinOptions}
          />
        </div>
      </div>
      <FailoverNote servers={members.length} />
      {/* A server joining or leaving changes on its own: the page follows it. */}
      <AutoRefresh
        active={members.some(
          (m) => m.provisioning || (m.emptying && !m.emptying.error),
        )}
      />
    </div>
  );
}

async function ImageCopies({ clusterId }: { clusterId: string }) {
  const copies = await listClusterImageProgress(clusterId);
  if (copies.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        Failover is not ready for these Apps yet. Their latest version is still
        being copied.
      </p>
      <ul className="space-y-0.5 text-sm">
        {copies.map((c) => (
          <li key={c.appId}>
            <span className="font-medium">{c.appName}</span>: on {c.held} of{" "}
            {c.total} servers
          </li>
        ))}
      </ul>
    </div>
  );
}

async function Waiting({ cluster }: { cluster: Cluster }) {
  const names = await listClusterWaiting(cluster.id);
  if (names.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        Waiting for room in {cluster.name}. Deplo tries again every 30 seconds.{" "}
        <DocsLink topic="clusters.failover" />
      </p>
      <ul className="space-y-0.5 text-sm">
        {names.map((name) => (
          <li key={name} className="font-medium">
            {name}
          </li>
        ))}
      </ul>
    </div>
  );
}

// A leader that answers and hears too few servers moves nothing: never plain "Answering".
const TOO_FEW_BADGE = {
  label: "Too few servers answer",
  variant: "warning",
} as const;

export function leaderBadge(leader: ClusterLeader) {
  return leader.state === "running" && leader.failoverReady === false
    ? TOO_FEW_BADGE
    : LEADER_BADGE[leader.state];
}

async function LeaderLine({
  clusterId,
  servers,
}: {
  clusterId: string;
  servers: number;
}) {
  const [leader, choices] = await Promise.all([
    getClusterLeader(clusterId),
    listClusterLeaderChoices(clusterId),
  ]);
  return (
    <LeaderView
      leader={leader}
      choices={choices}
      servers={servers}
      clusterId={clusterId}
    />
  );
}

export function LeaderView({
  clusterId,
  leader,
  choices,
  servers,
}: {
  clusterId: string;
  leader: ClusterLeader;
  choices: ClusterLeaderChoice[];
  servers: number;
}) {
  const badge = leaderBadge(leader);
  const move = (
    <MoveLeaderButton
      clusterId={clusterId}
      options={choices}
      servers={servers}
    />
  );
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted-foreground">Leader runs on</span>
        <span className="font-medium">{leader.serverName}</span>
        <Badge variant={badge.variant}>{badge.label}</Badge>
        {!["running", "unavailable", "outdated"].includes(leader.state) && (
          <StartLeaderButton clusterId={clusterId} />
        )}
        {!leader.ownServerWarning && <div className="ml-auto">{move}</div>}
      </div>
      {leader.ownServerWarning && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-warning">
            {leader.ownServerWarning} <DocsLink topic="clusters.leader" />
          </p>
          <div className="ml-auto">{move}</div>
        </div>
      )}
      {leader.message && (
        <p className="text-xs text-muted-foreground">{leader.message}</p>
      )}
      {leader.failoverReady && (
        <p className="text-xs text-muted-foreground">
          Failover would work right now.
        </p>
      )}
      {leader.takenOverAt && (
        <p className="text-xs text-muted-foreground">
          Deplo&apos;s own machine leads this cluster until {leader.serverName}{" "}
          {leader.state === "outdated" ? "is updated" : "answers again"}.{" "}
          <DocsLink topic="clusters.leader" />
        </p>
      )}
      {leader.updateMessage && (
        <p className="text-xs text-warning">
          {leader.updateMessage} <DocsLink topic="clusters.updates" />
        </p>
      )}
      {leader.relayMessage && (
        <p className="text-xs text-warning">
          {leader.relayMessage} <DocsLink topic="clusters.leader" />
        </p>
      )}
    </div>
  );
}

/** What an open cluster says about itself, above the cards of its servers. */
export function ClusterPanel({
  cluster,
  members,
  joinOptions,
  teamIds,
  teams,
}: {
  cluster: Cluster;
  members: ClusterMember[];
  joinOptions: ClusterJoinOption[];
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
            <ClusterHeaderActions
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
        <Summary
          cluster={cluster}
          members={members}
          joinOptions={joinOptions}
        />
        <Suspense fallback={null}>
          <Waiting cluster={cluster} />
        </Suspense>
        <Suspense fallback={null}>
          <ImageCopies clusterId={cluster.id} />
        </Suspense>
        <Suspense
          fallback={<Bone>Leader runs on Deplo machine Answering</Bone>}
        >
          <LeaderLine clusterId={cluster.id} servers={members.length} />
        </Suspense>
      </CardContent>
    </Card>
  );
}
