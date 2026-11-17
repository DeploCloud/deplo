"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Copy,
  MoreHorizontal,
  Scale,
  Settings2,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import type { DocsTopic } from "@/lib/docs";
import { gqlAction } from "@/lib/graphql-client";
import { useRouter } from "@/lib/nav";
import type { LoadBalancingMode } from "@/lib/types/cluster";
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

const SET_REPLICATION = /* GraphQL */ `
  mutation SetClusterReplication($id: String!, $enabled: Boolean!) {
    setClusterReplication(id: $id, enabled: $enabled) {
      id
      replicationEnabled
      loadBalancingEnabled
    }
  }
`;

const SET_LOAD_BALANCING = /* GraphQL */ `
  mutation SetClusterLoadBalancing(
    $id: String!
    $enabled: Boolean!
    $mode: ClusterLoadBalancingMode
  ) {
    setClusterLoadBalancing(id: $id, enabled: $enabled, mode: $mode) {
      id
      loadBalancingEnabled
      loadBalancingMode
    }
  }
`;

export type ClusterBarData = {
  id: string;
  name: string;
  allTeams: boolean;
  teamIds: string[];
  failoverEnabled: boolean;
  replicationEnabled: boolean;
  loadBalancingEnabled: boolean;
  loadBalancingMode: LoadBalancingMode;
};

/** A value shown at once and put back if Deplo refuses; a refresh that brings a new one from the server wins. */
function useShownValue<T>(server: T) {
  const [shown, setShown] = React.useState(server);
  const [saved, setSaved] = React.useState(server);
  if (saved !== server) {
    setSaved(server);
    setShown(server);
  }
  return [shown, setShown] as const;
}

/** One cluster switch: the mutation, the toast, and the value put back on a refusal. */
function useClusterSwitch(
  cluster: { id: string },
  value: boolean,
  query: string,
  done: (enabled: boolean) => string,
) {
  const router = useRouter();
  const [on, setOn] = useShownValue(value);
  const [pending, startTransition] = React.useTransition();
  const set = (enabled: boolean) => {
    setOn(enabled);
    startTransition(async () => {
      const res = await gqlAction(query, { id: cluster.id, enabled });
      if (!res.ok) {
        setOn(!enabled);
        return void toast.error(res.error);
      }
      toast.success(done(enabled));
      router.refresh();
    });
  };
  return { on, pending, set };
}

/** Turns a cluster's failover on or off, shown at once and put back if Deplo refuses. */
export function useFailoverSwitch(cluster: {
  id: string;
  name: string;
  failoverEnabled: boolean;
}) {
  return useClusterSwitch(
    cluster,
    cluster.failoverEnabled,
    SET_FAILOVER,
    (on) => `Failover ${on ? "on" : "off"} for ${cluster.name}`,
  );
}

/** Turns a cluster's replication on or off. */
export function useReplicationSwitch(cluster: {
  id: string;
  name: string;
  replicationEnabled: boolean;
}) {
  return useClusterSwitch(
    cluster,
    cluster.replicationEnabled,
    SET_REPLICATION,
    (on) => `Replication ${on ? "on" : "off"} for ${cluster.name}`,
  );
}

export const FAILOVER_HINT =
  "On: when a server stops, its Apps and databases restart on another server. Apps with stored data need replication to move.";

export const REPLICATION_HINT =
  "Streams each App's stored data and each database's changes to the other servers as they happen, so failover moves them with almost nothing lost.";

export const LOAD_BALANCING_HINT =
  "Runs Apps on a Cloudflare domain on every server and shares their visitors. Needs replication; Apps with stored data stay on one server.";

export const MODE_LABELS: Record<LoadBalancingMode, string> = {
  nearest: "Nearest server",
  most_available: "Most available server",
};

/** Load balancing on or off, and where it sends visitors. Off while replication is. */
function LoadBalancingRow({ cluster }: { cluster: ClusterBarData }) {
  const router = useRouter();
  const [on, setOn] = useShownValue(cluster.loadBalancingEnabled);
  const [mode, setMode] = useShownValue(cluster.loadBalancingMode);
  const [pending, startTransition] = React.useTransition();
  const save = (enabled: boolean, next: LoadBalancingMode) => {
    const before = { on, mode };
    setOn(enabled);
    setMode(next);
    startTransition(async () => {
      const res = await gqlAction(SET_LOAD_BALANCING, {
        id: cluster.id,
        enabled,
        mode: next,
      });
      if (!res.ok) {
        setOn(before.on);
        setMode(before.mode);
        return void toast.error(res.error);
      }
      toast.success(
        enabled === before.on
          ? `${cluster.name} sends visitors to the ${MODE_LABELS[next].toLowerCase()}`
          : `Load balancing ${enabled ? "on" : "off"} for ${cluster.name}`,
      );
      router.refresh();
    });
  };
  const switchId = `load-balancing-${cluster.id}`;
  return (
    <SettingItem
      icon={Scale}
      title="Load balancing"
      htmlFor={switchId}
      info={LOAD_BALANCING_HINT}
      docs="clusters.loadBalancing"
      description="Share an app's visitors between the servers that run it."
      control={
        <Switch
          id={switchId}
          checked={on}
          disabled={pending || (!on && !cluster.replicationEnabled)}
          onCheckedChange={(enabled) => save(enabled, mode)}
        />
      }
    >
      {on && (
        <Select
          value={mode}
          disabled={pending}
          onValueChange={(next) => save(true, next as LoadBalancingMode)}
        >
          <SelectTrigger className="w-full" aria-label="Send visitors to">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(MODE_LABELS) as LoadBalancingMode[]).map((m) => (
              <SelectItem key={m} value={m}>
                {MODE_LABELS[m]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </SettingItem>
  );
}

function SwitchItem({
  id,
  icon,
  label,
  hint,
  description,
  docs,
  value,
}: {
  id: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  description: string;
  docs?: DocsTopic;
  value: { on: boolean; pending: boolean; set: (on: boolean) => void };
}) {
  return (
    <SettingItem
      icon={icon}
      title={label}
      htmlFor={id}
      info={hint}
      docs={docs}
      description={description}
      control={
        <Switch
          id={id}
          checked={value.on}
          disabled={value.pending}
          onCheckedChange={value.set}
        />
      }
    />
  );
}

/** An open cluster's switches: failover, replication and load balancing. */
export function ClusterSettings({ cluster }: { cluster: ClusterBarData }) {
  const failover = useFailoverSwitch(cluster);
  const replication = useReplicationSwitch(cluster);
  return (
    <Card className="divide-y divide-border">
      <SwitchItem
        id={`failover-${cluster.id}`}
        icon={ShieldCheck}
        label="Failover"
        hint={FAILOVER_HINT}
        description="When a server stops, its apps move to another one."
        docs="clusters.failoverSwitch"
        value={failover}
      />
      <SwitchItem
        id={`replication-${cluster.id}`}
        icon={Copy}
        label="Replication"
        hint={REPLICATION_HINT}
        description="Keep a copy of every app's data on the other servers."
        docs="clusters.replicationSwitch"
        value={replication}
      />
      <LoadBalancingRow
        cluster={{ ...cluster, replicationEnabled: replication.on }}
      />
    </Card>
  );
}

/** An open cluster's own menu: Manage and Delete. */
export function ClusterMenu({
  cluster,
  teams,
}: {
  cluster: ClusterBarData;
  teams: TeamOption[];
}) {
  const [manage, setManage] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Cluster menu">
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
    </>
  );
}
