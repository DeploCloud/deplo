"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plug } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { McpConnectionDTO } from "@/lib/data/mcp-clients";

/**
 * The AI clients connected to this team.
 *
 * Each row is an API token someone approved on the consent screen, so Revoke is
 * the same `revokeToken` the tokens page calls — one lever over a credential,
 * not two that can drift. The same row also appears in Settings → API tokens,
 * marked, so one screen still answers "who can act in this team".
 *
 * This screen speaks about THIS team and nothing else. One consent can approve
 * several teams and Revoke removes only the active one's access - but the other
 * teams are somebody else's business, sometimes literally (a member here need
 * not belong to them), so neither the row nor the dialog names them. The copy
 * stays true by saying what happens here rather than what survives elsewhere.
 *
 * No action on the empty state: connecting happens in the card above.
 */
export function ConnectedClients({
  connections,
  canManage,
}: {
  connections: McpConnectionDTO[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [revoke, setRevoke] = React.useState<McpConnectionDTO | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Connected clients
          <InfoTip content="Revoking one takes away this team's access from its next request." />
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Apps connected to this team, each holding the permissions it was
          approved with.
        </p>
      </CardHeader>
      <CardContent>
        {connections.length === 0 ? (
          <EmptyState
            icon={Plug}
            title="No apps connected"
            description="Paste the server URL above into Claude or ChatGPT to connect one."
          />
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {connections.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-4 p-3"
              >
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-sm font-medium">{c.clientName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {c.username ? `Approved by ${c.username}` : "Approved"}
                    {c.redirectOrigin ? ` · ${c.redirectOrigin}` : ""} ·{" "}
                    {c.capabilities.length} permission
                    {c.capabilities.length === 1 ? "" : "s"} ·{" "}
                    {c.lastUsedAt ? `used ${timeAgo(c.lastUsedAt)}` : "never used"}
                  </p>
                </div>
                {canManage ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRevoke(c)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </CardContent>

      <ConfirmAction
        open={revoke !== null}
        onOpenChange={(v) => !v && setRevoke(null)}
        title={revoke ? `Revoke ${revoke.clientName}?` : "Revoke this client?"}
        // True whether or not the same consent reaches anywhere else, and it
        // never has to name where: from here, the client is gone until someone
        // approves it again.
        description="It loses this team's access immediately and has to be approved again to come back. This can't be undone."
        confirmLabel="Revoke"
        successMessage="Access removed"
        onConfirm={async () => {
          const res = await gqlAction(
            `mutation($id: String!) { revokeToken(id: $id) }`,
            { id: revoke!.id },
          );
          if (res.ok) router.refresh();
          return res;
        }}
      />
    </Card>
  );
}
