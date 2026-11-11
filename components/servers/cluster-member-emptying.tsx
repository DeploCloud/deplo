"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Play, Undo2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { DocsLink } from "@/components/ui/docs-link";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { RowActions } from "@/components/shared/row-actions";
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

export function MemberEmptyingActions({
  clusterId,
  serverId,
  serverName,
  state,
}: {
  clusterId: string;
  serverId: string;
  serverName: string;
  state: MemberEmptyingState;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const vars = { clusterId, serverId };

  const run = (query: string) =>
    startTransition(async () => {
      const res = await gqlAction(query, vars);
      if (!res.ok) toast.error(res.error);
      router.refresh();
    });

  if (state === "idle")
    return (
      <ConfirmAction
        trigger={
          <Button variant="outline" size="sm">
            Empty
          </Button>
        }
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
    );

  const stop = (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() => run(STOP)}
    >
      {state === "empty" ? "Use again" : "Stop emptying"}
    </Button>
  );
  if (state !== "stopped") return stop;
  return (
    <RowActions
      title={serverName}
      actions={[
        { label: "Continue", icon: Play, onSelect: () => run(EMPTY) },
        { label: "Stop emptying", icon: Undo2, onSelect: () => run(STOP) },
      ]}
    >
      <Button
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => run(EMPTY)}
      >
        Continue
      </Button>
      {stop}
    </RowActions>
  );
}
