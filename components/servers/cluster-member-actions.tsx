"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { ArrowRightFromLine, HardDrive } from "lucide-react";

import { DocsLink } from "@/components/ui/docs-link";
import { ChoiceCard } from "@/components/shared/choice-card";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { oneByOne } from "./server-bulk";

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
    $leaveBackups: Boolean
  ) {
    removeClusterMember(
      clusterId: $clusterId
      serverId: $serverId
      keepWorkloads: $keepWorkloads
      leaveBackups: $leaveBackups
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

/** Several servers leave at once: one choice for where all their Apps go. */
export function RemoveMembersDialog({
  open,
  onOpenChange,
  clusterId,
  clusterName,
  servers,
  memberCount,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  clusterId: string;
  clusterName: string;
  servers: { id: string; name: string; held: number }[];
  memberCount: number;
  onDone: () => void;
}) {
  const router = useRouter();
  const left = memberCount - servers.length;
  const held = servers.reduce((n, s) => n + s.held, 0);
  // With nobody left there is nowhere to send their work, so they may only leave with it.
  const [keep, setKeep] = React.useState(left === 0);
  const names = servers.map((s) => s.name).join(", ");
  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title={`Remove ${servers.length} servers`}
      description={
        <>
          <strong>{names}</strong> leave {clusterName} and stay your servers.{" "}
          <DocsLink topic="clusters.removing" />
        </>
      }
      consequence={
        left === 0
          ? `${clusterName} is left with no servers.`
          : left === 1
            ? `With one server left, ${clusterName} stops failing over.`
            : undefined
      }
      extra={
        held > 0 ? (
          <div role="radiogroup" className="space-y-2">
            <ChoiceCard
              icon={ArrowRightFromLine}
              title="Move their Apps to the other servers"
              blurb="One at a time. Anything with stored data pauses while it is copied. Each leaves once nothing is left on it."
              disabled={left === 0}
              disabledNote={`They are every server of ${clusterName}, so there is nowhere to move them.`}
              selected={!keep}
              onSelect={() => setKeep(false)}
            />
            <ChoiceCard
              icon={HardDrive}
              title="Keep their Apps on these servers"
              blurb="They leave at once. Their Apps and databases keep running where they are, and no longer fail over."
              selected={keep}
              onSelect={() => setKeep(true)}
            />
          </div>
        ) : undefined
      }
      confirmLabel="Remove"
      successMessage={
        held > 0 && !keep
          ? `Moving what they run, then they leave ${clusterName}`
          : `${servers.length} servers left ${clusterName}`
      }
      onConfirm={async () => {
        const res = await oneByOne(
          servers,
          (s) => s.name,
          (s) =>
            gqlAction(REMOVE_MEMBER, {
              clusterId,
              serverId: s.id,
              keepWorkloads: s.held > 0 && keep,
            }),
        );
        router.refresh();
        onDone();
        return res;
      }}
    />
  );
}
