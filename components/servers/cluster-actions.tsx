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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { gqlAction } from "@/lib/graphql-client";
import {
  ServerTeamAccess,
  accessIsComplete,
  type ServerAccess,
  type TeamOption,
} from "./server-team-access";

export function ClusterActions({
  cluster,
  teams,
}: {
  cluster: { id: string; name: string; allTeams: boolean; teamIds: string[] };
  teams: TeamOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
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
          `mutation RenameCluster($id: String!, $name: String!) {
            renameCluster(id: $id, name: $name) { id }
          }`,
          { id: cluster.id, name },
        );
        if (!res.ok) return void toast.error(res.error);
      }
      const res = await gqlAction(
        `mutation ShareCluster($id: String!, $sharing: ClusterSharingInput!) {
          setClusterTeams(id: $id, sharing: $sharing) { id }
        }`,
        {
          id: cluster.id,
          sharing: {
            allTeams: access.allTeams,
            teamIds: access.allTeams ? [] : access.teamIds,
          },
        },
      );
      if (!res.ok) return void toast.error(res.error);
      toast.success("Saved");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Settings2 className="size-4" />
          Manage
        </Button>
      </DialogTrigger>
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
            `mutation StartClusterLeader($id: String!) {
              startClusterLeader(id: $id) { state message }
            }`,
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
