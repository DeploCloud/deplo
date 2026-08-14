"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Plug } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { InfoTip } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  joinNames,
  revokeDescription,
  revokeTitle,
} from "@/components/settings/tokens/revoke-copy";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { McpConnectionDTO } from "@/lib/data/mcp-clients";
import type { TokenTeam } from "@/lib/data/tokens";

/** "Acme, Beta and 3 more" - the row has one line, the dialog names them all. */
function teamsSummary(teams: TokenTeam[]): string {
  const names = teams.map((t) => t.name);
  if (names.length <= 2) return joinNames(names);
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`;
}

/**
 * The AI clients connected to this team.
 *
 * Each row is an API token someone approved on the consent screen, so Revoke is
 * the same `revokeToken` the tokens page calls — one lever over a credential,
 * not two that can drift. The same row also appears in Settings → API tokens,
 * marked, so one screen still answers "who can act in this team".
 *
 * One consent can approve several teams, and Revoke removes THIS team's access
 * rather than the connection - so the row names the teams it reaches and the
 * dialog names the ones that survive. A connection that only reaches here reads
 * exactly as it always did.
 *
 * No action on the empty state: connecting happens in the card above.
 */
export function ConnectedClients({
  connections,
  activeTeamId,
  canManage,
}: {
  connections: McpConnectionDTO[];
  activeTeamId: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [revoke, setRevoke] = React.useState<McpConnectionDTO | null>(null);
  const copyFor = (c: McpConnectionDTO) => ({
    kind: "client" as const,
    teams: c.teams,
    activeTeamId,
    scoped: c.teams.length > 0,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Connected clients
          <InfoTip content="Revoking one takes away this team's access from its next request. It keeps working in any other team it was approved for." />
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
                    {c.redirectOrigin ? ` · ${c.redirectOrigin}` : ""}
                    {/* Only when it reaches somewhere else: on the usual
                        single-team connection the team name is the page. */}
                    {c.teams.length > 1 ? ` · ${teamsSummary(c.teams)}` : ""} ·{" "}
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
        title={
          revoke
            ? revokeTitle(revoke.clientName, copyFor(revoke))
            : "Revoke this client?"
        }
        description={
          revoke
            ? revokeDescription(copyFor(revoke))
            : "It loses access immediately and will have to be connected again from scratch. This can't be undone."
        }
        confirmLabel="Revoke"
        successMessage={
          revoke && revoke.teams.length > 1 ? "Access removed" : "Client revoked"
        }
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
