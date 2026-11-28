"use client";

import * as React from "react";
import { Trash2 } from "lucide-react";
import { useRouter } from "@/lib/nav";

import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { formatBytes } from "@/lib/utils";

export type SetAsideCopy = {
  serverId: string;
  serverName: string;
  volumeName: string;
  of: string;
  at: string;
  bytes: number;
};

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

/** The dated copies a cluster server kept of this App's data when it came back after the App moved. */
export function SetAsideCopies({
  appId,
  copies,
  canRemove,
}: {
  appId: string;
  copies: SetAsideCopy[];
  canRemove: boolean;
}) {
  const router = useRouter();
  if (copies.length === 0) return null;
  return (
    <div className="space-y-3 rounded-xl border p-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Set-aside copies</h3>
        <p className="text-sm text-muted-foreground">
          A server that came back after this App moved kept what it held, with
          any writes its copy had not sent yet. Nothing here runs; remove a copy
          once you no longer need it.
        </p>
      </div>
      <ul className="divide-y text-sm">
        {copies.map((c) => (
          <li
            key={`${c.serverId}/${c.volumeName}`}
            className="flex items-center justify-between gap-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate font-medium">
                {when(c.at)} on {c.serverName}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">
                {c.of} · {formatBytes(c.bytes)}
              </p>
            </div>
            {canRemove && (
              <ConfirmAction
                trigger={
                  <Button variant="outline" size="sm">
                    <Trash2 className="size-4" />
                    Remove
                  </Button>
                }
                title="Remove this copy?"
                description={`The copy ${c.serverName} kept on ${when(c.at)} is deleted for good, with any writes only it holds.`}
                confirmLabel="Remove"
                successMessage="Copy removed"
                onConfirm={async () => {
                  const res = await gqlAction(
                    /* GraphQL */ `
                      mutation RemoveAppSetAsideCopy(
                        $appId: String!
                        $serverId: String!
                        $volumeName: String!
                      ) {
                        removeAppSetAsideCopy(
                          appId: $appId
                          serverId: $serverId
                          volumeName: $volumeName
                        )
                      }
                    `,
                    { appId, serverId: c.serverId, volumeName: c.volumeName },
                  );
                  if (res.ok) router.refresh();
                  return res;
                }}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
