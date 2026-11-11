"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  ArrowRightFromLine,
  Play,
  RotateCcw,
  Trash2,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DocsLink } from "@/components/ui/docs-link";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { RowActions, type RowAction } from "@/components/shared/row-actions";
import { gqlAction } from "@/lib/graphql-client";

export type MemberEmptyingState = "idle" | "emptying" | "stopped" | "empty";

const EMPTY = /* GraphQL */ `
  mutation EmptyClusterMember($clusterId: String!, $serverId: String!) {
    emptyClusterMember(clusterId: $clusterId, serverId: $serverId) {
      id
    }
  }
`;

const STOP = /* GraphQL */ `
  mutation StopEmptyingClusterMember($clusterId: String!, $serverId: String!) {
    stopEmptyingClusterMember(clusterId: $clusterId, serverId: $serverId) {
      id
    }
  }
`;

const REMOVE = /* GraphQL */ `
  mutation RemoveClusterMember(
    $clusterId: String!
    $serverId: String!
    $keepWorkloads: Boolean
  ) {
    removeClusterMember(
      clusterId: $clusterId
      serverId: $serverId
      keepWorkloads: $keepWorkloads
    ) {
      id
    }
  }
`;

export function MemberActions({
  clusterId,
  clusterName,
  serverId,
  serverName,
  state,
  held,
  memberCount,
}: {
  clusterId: string;
  clusterName: string;
  serverId: string;
  serverName: string;
  state: MemberEmptyingState;
  /** How many Apps and databases the server still holds. */
  held: number;
  memberCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [dialog, setDialog] = React.useState<"empty" | "remove" | null>(null);
  const [keep, setKeep] = React.useState(false);
  const vars = { clusterId, serverId };
  const last = memberCount === 1;
  // The last server has nowhere to send its work, so it may leave with it.
  const keeps = last && held > 0;

  const run = (query: string) =>
    startTransition(async () => {
      const res = await gqlAction(query, vars);
      if (!res.ok) toast.error(res.error);
      router.refresh();
    });

  const actions: RowAction[] = [];
  // Emptying needs another server to move to.
  if (state === "idle" && !last)
    actions.push({
      label: "Empty",
      icon: ArrowRightFromLine,
      onSelect: () => setDialog("empty"),
    });
  if (state === "stopped")
    actions.push({ label: "Continue", icon: Play, onSelect: () => run(EMPTY) });
  if (state !== "idle")
    actions.push({
      label: state === "empty" ? "Use again" : "Stop emptying",
      icon: state === "empty" ? RotateCcw : Undo2,
      onSelect: () => run(STOP),
    });
  if (held === 0 || last)
    actions.push({
      label: "Remove",
      icon: Trash2,
      destructive: true,
      onSelect: () => setDialog("remove"),
    });

  return (
    <>
      <RowActions title={serverName} actions={actions}>
        {actions.map((a) => (
          <Button
            key={a.label}
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={a.onSelect}
          >
            {a.label}
          </Button>
        ))}
      </RowActions>
      <ConfirmAction
        open={dialog === "empty"}
        onOpenChange={(v) => setDialog(v ? "empty" : null)}
        title="Empty this server"
        description={
          <>
            Its Apps and databases move to the other servers, one at a time.{" "}
            <strong>
              Anything with stored data pauses while it is copied.
            </strong>{" "}
            <DocsLink topic="clusters.emptying" />
          </>
        }
        confirmLabel="Empty"
        variant="default"
        onConfirm={async () => {
          const res = await gqlAction(EMPTY, vars);
          if (res.ok) router.refresh();
          return res;
        }}
      />
      <ConfirmAction
        open={dialog === "remove"}
        onOpenChange={(v) => {
          setDialog(v ? "remove" : null);
          setKeep(false);
        }}
        title="Remove this server"
        description={
          keeps ? (
            <>
              It is the last server of {clusterName}, so{" "}
              <strong>its Apps have nowhere to move</strong>.{" "}
              <DocsLink topic="clusters.removing" />
            </>
          ) : (
            <>
              <strong>{serverName}</strong> leaves {clusterName} at once and is
              an ordinary server again. <DocsLink topic="clusters.removing" />
            </>
          )
        }
        consequence={
          memberCount === 2
            ? `With one server left, ${clusterName} stops failing over.`
            : undefined
        }
        extra={
          keeps ? (
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border p-3 text-sm">
              <Checkbox
                checked={keep}
                onCheckedChange={(v) => setKeep(v === true)}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">
                  Keep its Apps on this server
                </span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  Its Apps and databases keep running here. Nothing restarts.
                </span>
              </span>
            </label>
          ) : undefined
        }
        confirmDisabled={keeps && !keep}
        confirmLabel="Remove"
        successMessage={`${serverName} left ${clusterName}`}
        onConfirm={async () => {
          const res = await gqlAction(REMOVE, {
            ...vars,
            keepWorkloads: keeps,
          });
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </>
  );
}
