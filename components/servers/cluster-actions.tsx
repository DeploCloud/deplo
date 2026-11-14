"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DocsLink } from "@/components/ui/docs-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { comesAlong, type ClusterJoinOption } from "./cluster-join";
import {
  ServerTeamAccess,
  accessIsComplete,
  type ServerAccess,
  type TeamOption,
} from "./server-team-access";

export function ClusterActions({
  cluster,
  teams,
  open,
  onOpenChange: setOpen,
  trigger = true,
}: {
  cluster: { id: string; name: string; allTeams: boolean; teamIds: string[] };
  teams: TeamOption[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // A card's menu opens it instead.
  trigger?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState(cluster.name);
  const [access, setAccess] = React.useState<ServerAccess>({
    allTeams: cluster.allTeams,
    teamIds: cluster.teamIds,
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      if (name.trim() !== cluster.name) {
        const res = await gqlAction(
          /* GraphQL */ `
            mutation RenameCluster($id: String!, $name: String!) {
              renameCluster(id: $id, name: $name) {
                id
              }
            }
          `,
          { id: cluster.id, name },
        );
        if (!res.ok) return void toast.error(res.error);
      }
      const res = await gqlAction(
        /* GraphQL */ `
          mutation ShareCluster($id: String!, $sharing: ClusterSharingInput!) {
            setClusterTeams(id: $id, sharing: $sharing) {
              id
            }
          }
        `,
        {
          id: cluster.id,
          sharing: {
            allTeams: access.allTeams,
            teamIds: access.allTeams ? [] : access.teamIds,
          },
        },
      );
      if (!res.ok) {
        // The rename above may already be saved: show what the cluster is now.
        router.refresh();
        return void toast.error(res.error);
      }
      toast.success("Saved");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger && (
        <DialogTrigger asChild>
          <Button variant="outline" size="sm">
            <Settings2 className="size-4" />
            Manage
          </Button>
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage cluster</DialogTitle>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-2">
            <Label htmlFor={`clu-${cluster.id}-name`}>Name</Label>
            <Input
              id={`clu-${cluster.id}-name`}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <ServerTeamAccess
            value={access}
            teams={teams}
            onChange={setAccess}
            disabled={pending}
            info="Which teams are allowed to place Apps and databases on this cluster."
            docs="clusters.teams"
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending || !name.trim() || !accessIsComplete(access)}
            >
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function StartLeaderButton({ clusterId }: { clusterId: string }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const res = await gqlAction<{
            startClusterLeader: { state: string; message: string };
          }>(
            /* GraphQL */ `
              mutation StartClusterLeader($id: String!) {
                startClusterLeader(id: $id) {
                  state
                  message
                }
              }
            `,
            { id: clusterId },
          );
          if (!res.ok) return void toast.error(res.error);
          const leader = res.data?.startClusterLeader;
          if (leader && leader.state !== "running") toast.error(leader.message);
          router.refresh();
        })
      }
    >
      Try again
    </Button>
  );
}

export type LeaderOption = {
  serverId: string;
  serverName: string;
  onDeploHost: boolean;
  current: boolean;
  /** Why the leader cannot run there right now; empty when it can. */
  blocked: string;
  /** What a leader there cannot do; empty when nothing. */
  note: string;
};

// What moving the leader buys: nothing while Deplo is down, under three servers.
export function MoveLeaderLead({ servers }: { servers: number }) {
  return servers >= 3 ? (
    <>
      Failover keeps working{" "}
      <strong>while Deplo&apos;s own machine is down</strong>.
    </>
  ) : (
    <>
      Under three servers, failover still <strong>needs Deplo up</strong>{" "}
      wherever the leader runs.
    </>
  );
}

const MOVE_LEADER = /* GraphQL */ `
  mutation MoveClusterLeader($id: String!, $serverId: String!) {
    moveClusterLeader(id: $id, serverId: $serverId) {
      id
    }
  }
`;

/** Runs the leader on one server, from that server's own menu. */
export function MakeLeaderConfirm({
  clusterId,
  choice,
  servers,
  open,
  onOpenChange,
}: {
  clusterId: string;
  choice: LeaderOption;
  servers: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const where = choice.onDeploHost ? "Deplo's own machine" : choice.serverName;
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      variant="default"
      title={`Run the leader on ${where}?`}
      description={
        <>
          <MoveLeaderLead servers={servers} />{" "}
          <DocsLink topic="clusters.leader" />
        </>
      }
      consequence={choice.note || undefined}
      confirmLabel="Make leader"
      successMessage={`The leader now runs on ${where}`}
      onConfirm={async () => {
        const res = await gqlAction(MOVE_LEADER, {
          id: clusterId,
          serverId: choice.serverId,
        });
        router.refresh();
        return res;
      }}
    />
  );
}

const ADD_MEMBER = /* GraphQL */ `
  mutation AddClusterMember($clusterId: String!, $serverId: String!) {
    addClusterMember(clusterId: $clusterId, serverId: $serverId) {
      note
    }
  }
`;

/** Puts a server in a cluster; the note is the one line the cluster has to say about its new size. */
export async function joinCluster(clusterId: string, serverId: string) {
  return gqlAction<
    { addClusterMember: { note: string | null } },
    string | null
  >(ADD_MEMBER, { clusterId, serverId }, (d) => d.addClusterMember.note);
}

// What joining does to a server that already runs something. Shown before the join, never after.
export function JoinsWith({
  option,
  clusterName,
}: {
  option: ClusterJoinOption;
  clusterName: string;
}) {
  const what = comesAlong(option.apps, option.databases);
  if (!what) return null;
  return (
    <p className="text-sm text-muted-foreground">
      {what} on {option.serverName} move into {clusterName} with it. They keep
      running, and from then on the cluster decides where.
    </p>
  );
}

/** Asked before a server that runs something joins: its Apps and databases move into the cluster with it. */
export function JoinClusterConfirm({
  open,
  onOpenChange,
  option,
  cluster,
  onJoin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  option: ClusterJoinOption;
  cluster: { id: string; name: string };
  onJoin: () => ReturnType<typeof joinCluster>;
}) {
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      variant="default"
      title={`Move ${option.serverName} into ${cluster.name}?`}
      description={
        <>
          <strong>{comesAlong(option.apps, option.databases)}</strong> on it
          move into the cluster too. <DocsLink topic="clusters.overview" />
        </>
      }
      extra={
        <p className="text-sm text-muted-foreground">
          They keep running without a restart. From then on {cluster.name}{" "}
          decides where they run, and nothing is placed on {option.serverName}{" "}
          directly.
        </p>
      }
      confirmLabel="Move"
      onConfirm={onJoin}
    />
  );
}
