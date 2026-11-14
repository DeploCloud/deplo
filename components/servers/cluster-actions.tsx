"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Plus, Settings2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { DocsLink } from "@/components/ui/docs-link";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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

// The server select both dialogs share, with what blocks or limits each server listed under it.
function ServerPick({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: string;
  onChange: (serverId: string) => void;
  options: {
    serverId: string;
    label: string;
    disabled: boolean;
    hint: string;
  }[];
}) {
  const hints = options.filter((o) => o.hint);
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Server</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue placeholder="Choose a server" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem
              key={o.serverId}
              value={o.serverId}
              disabled={o.disabled}
            >
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {hints.length > 0 && (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {hints.map((o) => (
            <li key={o.serverId}>{o.hint}</li>
          ))}
        </ul>
      )}
    </div>
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

export function MoveLeaderButton({
  clusterId,
  options,
  servers,
}: {
  clusterId: string;
  options: LeaderOption[];
  // How many servers the cluster has: under three, a leader elsewhere still needs Deplo up.
  servers: number;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [serverId, setServerId] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const chosen = options.find((o) => o.serverId === serverId);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction(
        /* GraphQL */ `
          mutation MoveClusterLeader($id: String!, $serverId: String!) {
            moveClusterLeader(id: $id, serverId: $serverId) {
              id
            }
          }
        `,
        { id: clusterId, serverId },
      );
      if (!res.ok) return void toast.error(res.error);
      toast.success(`The leader now runs on ${chosen?.serverName}`);
      setOpen(false);
      setServerId("");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Run on another server
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run the leader on another server</DialogTitle>
          <DialogDescription>
            <MoveLeaderLead servers={servers} />{" "}
            <DocsLink topic="clusters.leader" />
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <ServerPick
            id={`leader-${clusterId}`}
            value={serverId}
            onChange={setServerId}
            options={options.map((o) => ({
              serverId: o.serverId,
              label: `${o.serverName}${o.onDeploHost ? " (Deplo's own machine)" : ""}${o.current ? " (runs here now)" : ""}`,
              disabled: o.current || Boolean(o.blocked),
              hint: o.blocked || o.note,
            }))}
          />
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !chosen}>
              Move
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

export function JoinClusterButton({
  clusterId,
  clusterName,
  options,
}: {
  clusterId: string;
  clusterName: string;
  options: ClusterJoinOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [serverId, setServerId] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const chosen = options.find((o) => o.serverId === serverId);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await joinCluster(clusterId, serverId);
      if (!res.ok) return void toast.error(res.error);
      toast.success(res.data ?? "Server added");
      setOpen(false);
      setServerId("");
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" />
          Add server
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a server</DialogTitle>
          <DialogDescription>
            Its Apps and databases stay where they run, without a restart.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <ServerPick
            id={`join-${clusterId}`}
            value={serverId}
            onChange={setServerId}
            options={options.map((o) => ({
              serverId: o.serverId,
              label: o.serverName,
              disabled: Boolean(o.blocked),
              hint: o.blocked,
            }))}
          />
          {chosen && <JoinsWith option={chosen} clusterName={clusterName} />}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !chosen}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
