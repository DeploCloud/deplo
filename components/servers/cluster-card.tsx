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
  listClusterJoinCandidates,
  listClusterMembers,
} from "@/lib/data/clusters/members";
import {
  FAILOVER_MIN_MEMBERS,
  failoverOn,
  type Cluster,
  type ClusterEmptying,
  type ClusterLeader,
  type ClusterLeaderChoice,
} from "@/lib/types/cluster";
import type { ServerStatus } from "@/lib/types/server";
import {
  JoinClusterButton,
  MoveLeaderButton,
  StartLeaderButton,
} from "./cluster-actions";
import { ClusterHeaderActions } from "./cluster-delete";
import {
  MemberActions,
  type MemberEmptyingState,
} from "./cluster-member-actions";
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

const LEASE_BADGE = {
  not_responding: { label: "Not responding", variant: "warning" },
  fenced: { label: "Not responding", variant: "destructive" },
} as const;

// True whether the server is gone or its leader hears too few servers to keep it going.
export const FENCED_NOTE =
  "This server stopped its databases and Apps with files, so none of them can run twice.";

// The second line under the server count: what failover needs at this size.
export function FailoverNote({ servers }: { servers: number }) {
  if (servers !== FAILOVER_MIN_MEMBERS) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {TWO_SERVERS_NOTE} <DocsLink topic="clusters.leader" />
    </p>
  );
}

function emptyingState(e: ClusterEmptying | null): MemberEmptyingState {
  if (!e) return "idle";
  if (e.error) return "stopped";
  return e.left === 0 ? "empty" : "emptying";
}

const EMPTYING_BADGE = {
  emptying: { label: "Emptying", variant: "warning" },
  stopped: { label: "Emptying stopped", variant: "destructive" },
  empty: { label: "Empty", variant: "muted" },
} as const;

async function Members({ cluster }: { cluster: Cluster }) {
  const clusterId = cluster.id;
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
      <FailoverNote servers={members.length} />
      <AutoRefresh
        active={members.some((m) => emptyingState(m.emptying) === "emptying")}
      />
      {members.length > 0 && (
        <ul className="space-y-1">
          {members.map((m) => {
            const state = emptyingState(m.emptying);
            const e = m.emptying;
            return (
              <li key={m.serverId} className="space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="min-w-0 truncate font-medium">
                    {m.serverName}
                  </span>
                  <Badge variant={MEMBER_BADGE[m.status].variant}>
                    {MEMBER_BADGE[m.status].label}
                  </Badge>
                  {m.leaseState !== "ok" && (
                    <Badge variant={LEASE_BADGE[m.leaseState].variant}>
                      {LEASE_BADGE[m.leaseState].label}
                    </Badge>
                  )}
                  {state !== "idle" && (
                    <Badge variant={EMPTYING_BADGE[state].variant}>
                      {EMPTYING_BADGE[state].label}
                    </Badge>
                  )}
                  {e && state !== "empty" && (
                    <span className="text-xs text-muted-foreground">
                      {e.total - e.left} of {e.total} moved
                      {e.moving && `, moving ${e.moving}`}
                    </span>
                  )}
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    <MemberActions
                      clusterId={clusterId}
                      clusterName={cluster.name}
                      serverId={m.serverId}
                      serverName={m.serverName}
                      state={state}
                      held={m.held}
                      memberCount={members.length}
                    />
                  </div>
                </div>
                {m.leaseState === "fenced" && (
                  <p className="text-xs text-muted-foreground">{FENCED_NOTE}</p>
                )}
                {e?.error && (
                  <p className="text-xs text-muted-foreground">{e.error}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
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

async function LeaderLine({ clusterId }: { clusterId: string }) {
  const [leader, choices, members] = await Promise.all([
    getClusterLeader(clusterId),
    listClusterLeaderChoices(clusterId),
    listClusterMembers(clusterId),
  ]);
  return (
    <LeaderView
      leader={leader}
      choices={choices}
      servers={members.length}
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
        <Suspense fallback={<Bone>2 servers Failover on</Bone>}>
          <Members cluster={cluster} />
        </Suspense>
        <Suspense fallback={null}>
          <Waiting cluster={cluster} />
        </Suspense>
        <Suspense fallback={null}>
          <ImageCopies clusterId={cluster.id} />
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
