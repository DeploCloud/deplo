"use client";

import * as React from "react";
import { toast } from "sonner";
import { MoreHorizontal, Settings2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import { ClusterActions } from "./cluster-actions";
import { DeleteClusterButton } from "./cluster-delete";
import type { TeamOption } from "./server-team-access";

const SET_FAILOVER = /* GraphQL */ `
  mutation SetClusterFailover($id: String!, $enabled: Boolean!) {
    setClusterFailover(id: $id, enabled: $enabled) {
      id
      failoverEnabled
    }
  }
`;

export type ClusterBarData = {
  id: string;
  name: string;
  allTeams: boolean;
  teamIds: string[];
  failoverEnabled: boolean;
};

/** Turns a cluster's failover on or off, shown at once and put back if Deplo refuses. */
export function useFailoverSwitch(cluster: {
  id: string;
  name: string;
  failoverEnabled: boolean;
}) {
  const router = useRouter();
  const [on, setOn] = React.useState(cluster.failoverEnabled);
  const [saved, setSaved] = React.useState(cluster.failoverEnabled);
  const [pending, startTransition] = React.useTransition();
  // A refresh that brings a new value from the server wins over what was shown.
  if (saved !== cluster.failoverEnabled) {
    setSaved(cluster.failoverEnabled);
    setOn(cluster.failoverEnabled);
  }
  const set = (enabled: boolean) => {
    setOn(enabled);
    startTransition(async () => {
      const res = await gqlAction(SET_FAILOVER, { id: cluster.id, enabled });
      if (!res.ok) {
        setOn(!enabled);
        return void toast.error(res.error);
      }
      toast.success(`Failover ${enabled ? "on" : "off"} for ${cluster.name}`);
      router.refresh();
    });
  };
  return { on, pending, set };
}

export const FAILOVER_HINT =
  "On: when a server stops, its Apps and databases restart on another server of the cluster. Off: they wait for it to come back.";

/** What an open cluster offers, beside its trail: failover on or off, Manage and Delete. */
export function ClusterBar({
  cluster,
  teams,
}: {
  cluster: ClusterBarData;
  teams: TeamOption[];
}) {
  const [manage, setManage] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const failover = useFailoverSwitch(cluster);
  const switchId = `failover-${cluster.id}`;
  return (
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-2">
        <Label htmlFor={switchId} className="text-sm">
          Failover
        </Label>
        <InfoTip content={FAILOVER_HINT} docs="clusters.failoverSwitch" />
        <Switch
          id={switchId}
          checked={failover.on}
          disabled={failover.pending}
          onCheckedChange={failover.set}
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Cluster menu">
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem onSelect={() => setManage(true)}>
            <Settings2 className="size-4" />
            Manage
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={() => setDeleting(true)}
          >
            <Trash2 className="size-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ClusterActions
        cluster={cluster}
        teams={teams}
        open={manage}
        onOpenChange={setManage}
        trigger={false}
      />
      <DeleteClusterButton
        cluster={cluster}
        open={deleting}
        onOpenChange={setDeleting}
        trigger={false}
      />
    </div>
  );
}
