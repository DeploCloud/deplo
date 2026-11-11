"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Settings2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import { Bone } from "@/components/ui/skeleton";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { RowActions } from "@/components/shared/row-actions";
import { gqlAction } from "@/lib/graphql-client";
import type { ClusterDeletion } from "@/lib/types/cluster";
import { ClusterActions } from "./cluster-actions";
import type { TeamOption } from "./server-team-access";

const DELETION = /* GraphQL */ `
  query ClusterDeletion($id: String!) {
    clusterDeletion(id: $id) {
      failoverOn
      workloads {
        kind
        name
        serverName
        stopsOn
        waiting
      }
      otherTeams {
        teamName
        apps
        databases
      }
    }
  }
`;

const DELETE = /* GraphQL */ `
  mutation DeleteCluster($id: String!) {
    deleteCluster(id: $id)
  }
`;

const count = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const held = (info: ClusterDeletion) =>
  info.workloads.length + info.otherTeams.length;

function Released({ info }: { info: ClusterDeletion }) {
  if (held(info) === 0)
    return <p className="text-sm text-muted-foreground">Nothing runs on it.</p>;
  return (
    <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
      {info.workloads.map((w) => (
        <li key={`${w.kind}:${w.name}`}>
          <span className="font-medium">{w.name}</span>{" "}
          <span className="text-muted-foreground">
            {w.kind === "database" ? "database, " : ""}
            {w.waiting ? "not running, stays on" : "stays on"} {w.serverName}
            {w.stopsOn.length > 0 && `, stops on ${w.stopsOn.join(", ")}`}
          </span>
        </li>
      ))}
      {info.otherTeams.map((t) => (
        <li key={t.teamName} className="text-muted-foreground">
          {[
            t.apps > 0 && count(t.apps, "App"),
            t.databases > 0 && count(t.databases, "database"),
          ]
            .filter(Boolean)
            .join(" and ")}{" "}
          of {t.teamName}
        </li>
      ))}
    </ul>
  );
}

export function DeleteClusterButton({
  cluster,
  open,
  onOpenChange,
}: {
  cluster: { id: string; name: string };
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [info, setInfo] = React.useState<ClusterDeletion | null>(null);

  // Read each time it opens: what runs on the cluster changes under an open page.
  React.useEffect(() => {
    if (!open) return;
    let stale = false;
    void gqlAction<{ clusterDeletion: ClusterDeletion }>(DELETION, {
      id: cluster.id,
    }).then((res) => {
      if (stale) return;
      if (res.ok && res.data) return setInfo(res.data.clusterDeletion);
      if (!res.ok) toast.error(res.error);
      onOpenChange(false);
    });
    return () => {
      stale = true;
    };
  }, [open, cluster.id, onOpenChange]);

  return (
    <ConfirmAction
      open={open}
      onOpenChange={(v) => {
        if (!v) setInfo(null);
        onOpenChange(v);
      }}
      trigger={
        <Button variant="outline" size="sm">
          <Trash2 className="size-4" />
          Delete
        </Button>
      }
      title={`Delete ${cluster.name}`}
      description={
        <>
          Its servers stay connected and{" "}
          <strong>everything keeps running where it is</strong>.{" "}
          <DocsLink topic="clusters.deleting" />
        </>
      }
      consequence={
        info?.failoverOn && held(info) > 0
          ? "These stop failing over. If a server stops, what runs on it stays down."
          : undefined
      }
      extra={
        info ? (
          <Released info={info} />
        ) : (
          <Bone className="text-sm">web stays on server-a</Bone>
        )
      }
      confirmDisabled={!info}
      confirmLabel="Delete"
      successMessage={`Deleted ${cluster.name}`}
      onConfirm={async () => {
        const res = await gqlAction(DELETE, { id: cluster.id });
        if (res.ok) router.refresh();
        return res;
      }}
    />
  );
}

/** A cluster card's own actions: two buttons, one kebab on a phone. */
export function ClusterHeaderActions({
  cluster,
  teams,
}: {
  cluster: { id: string; name: string; allTeams: boolean; teamIds: string[] };
  teams: TeamOption[];
}) {
  const [manage, setManage] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  return (
    <RowActions
      title={cluster.name}
      actions={[
        { label: "Manage", icon: Settings2, onSelect: () => setManage(true) },
        {
          label: "Delete",
          icon: Trash2,
          destructive: true,
          onSelect: () => setDeleting(true),
        },
      ]}
    >
      <ClusterActions
        cluster={cluster}
        teams={teams}
        open={manage}
        onOpenChange={setManage}
      />
      <DeleteClusterButton
        cluster={cluster}
        open={deleting}
        onOpenChange={setDeleting}
      />
    </RowActions>
  );
}
