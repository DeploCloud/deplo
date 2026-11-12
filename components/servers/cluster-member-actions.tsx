"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import {
  ArrowRightFromLine,
  HardDrive,
  Play,
  Trash2,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import { ChoiceCard } from "@/components/shared/choice-card";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { RowActions, type RowAction } from "@/components/shared/row-actions";
import { gqlAction } from "@/lib/graphql-client";

export type MemberEmptyingState = "idle" | "removing" | "stopped";

const CANCEL = /* GraphQL */ `
  mutation CancelClusterMemberRemoval($clusterId: String!, $serverId: String!) {
    cancelClusterMemberRemoval(clusterId: $clusterId, serverId: $serverId) {
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
  const [open, setOpen] = React.useState(false);
  const last = memberCount === 1;
  // The last server has nowhere to send its work, so it may only leave with it.
  const [keep, setKeep] = React.useState(last);
  const vars = { clusterId, serverId };

  const run = (query: string, extra: Record<string, unknown> = {}) =>
    startTransition(async () => {
      const res = await gqlAction(query, { ...vars, ...extra });
      if (!res.ok) toast.error(res.error);
      router.refresh();
    });

  const actions: RowAction[] = [];
  if (state === "stopped")
    actions.push({
      label: "Continue",
      icon: Play,
      onSelect: () => run(REMOVE, { keepWorkloads: false }),
    });
  if (state !== "idle")
    actions.push({
      label: "Cancel",
      icon: Undo2,
      onSelect: () => run(CANCEL),
    });
  if (state === "idle")
    actions.push({
      label: "Remove",
      icon: Trash2,
      destructive: true,
      onSelect: () => {
        setKeep(last);
        setOpen(true);
      },
    });

  const moves = held > 0 && !keep;
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
        open={open}
        onOpenChange={setOpen}
        title="Remove this server"
        description={
          <>
            <strong>{serverName}</strong> leaves {clusterName} and stays one of
            your servers. <DocsLink topic="clusters.removing" />
          </>
        }
        consequence={
          memberCount === 2
            ? `With one server left, ${clusterName} stops failing over.`
            : undefined
        }
        extra={
          held > 0 ? (
            <div role="radiogroup" className="space-y-2">
              <ChoiceCard
                icon={ArrowRightFromLine}
                title="Move its Apps to the other servers"
                blurb="One at a time. Anything with stored data pauses while it is copied. It leaves once nothing is left."
                disabled={last}
                disabledNote={`It is the last server of ${clusterName}, so there is nowhere to move them.`}
                selected={!keep}
                onSelect={() => setKeep(false)}
              />
              <ChoiceCard
                icon={HardDrive}
                title="Keep its Apps on this server"
                blurb="It leaves at once. Its Apps and databases keep running here, and no longer fail over."
                selected={keep}
                onSelect={() => setKeep(true)}
              />
            </div>
          ) : undefined
        }
        confirmLabel="Remove"
        successMessage={
          moves
            ? `Moving what ${serverName} runs, then it leaves ${clusterName}`
            : `${serverName} left ${clusterName}`
        }
        onConfirm={async () => {
          const res = await gqlAction(REMOVE, {
            ...vars,
            keepWorkloads: held > 0 && keep,
          });
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </>
  );
}
