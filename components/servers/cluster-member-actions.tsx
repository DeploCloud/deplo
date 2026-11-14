"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { ArrowRightFromLine, HardDrive } from "lucide-react";

import { DocsLink } from "@/components/ui/docs-link";
import { ChoiceCard } from "@/components/shared/choice-card";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";

export type MemberEmptyingState = "idle" | "removing" | "stopped";

export const CANCEL_MEMBER_REMOVAL = /* GraphQL */ `
  mutation CancelClusterMemberRemoval($clusterId: String!, $serverId: String!) {
    cancelClusterMemberRemoval(clusterId: $clusterId, serverId: $serverId) {
      id
    }
  }
`;

export const REMOVE_MEMBER = /* GraphQL */ `
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

/** The confirmation of taking a server out of its cluster: where its Apps go is the one choice. */
export function RemoveMemberDialog({
  open,
  onOpenChange,
  clusterId,
  clusterName,
  serverId,
  serverName,
  held,
  memberCount,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusterId: string;
  clusterName: string;
  serverId: string;
  serverName: string;
  /** How many Apps and databases the server still holds. */
  held: number;
  memberCount: number;
}) {
  const router = useRouter();
  const last = memberCount === 1;
  // The last server has nowhere to send its work, so it may only leave with it.
  const [keep, setKeep] = React.useState(last);
  const moves = held > 0 && !keep;
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
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
        const res = await gqlAction(REMOVE_MEMBER, {
          clusterId,
          serverId,
          keepWorkloads: held > 0 && keep,
        });
        if (res.ok) router.refresh();
        return res;
      }}
    />
  );
}
