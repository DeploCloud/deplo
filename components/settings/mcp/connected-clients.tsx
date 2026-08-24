"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { InfoTip } from "@/components/ui/info-tip";
import { EmptyState } from "@/components/shared/empty-state";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { useOptimisticRemove } from "@/components/shared/use-optimistic-remove";
import { RobotGraphic } from "./robot-graphic";
import { gqlAction } from "@/lib/graphql-client";
import { timeAgo } from "@/lib/utils";
import type { McpConnectionDTO } from "@/lib/data/mcp-clients";

/**
 * Everything that can act in this team over MCP.
 *
 * Two kinds in one list, because "who can drive our infrastructure" is one
 * question. A `web` row is an OAuth connector approved on deplo's consent
 * screen; a `token` row is an API token somebody pasted into a terminal or IDE
 * agent, and it appears here once it has actually called `/api/mcp` — a token
 * that merely could is a credential, not a connection, and lives on the API
 * tokens page.
 *
 * Revoke is `revokeToken` for both, because both ARE API tokens (ADR-0022 §1).
 * One lever over a credential, never two that can drift.
 *
 * This screen speaks about THIS team and nothing else. One consent can approve
 * several teams, and Revoke ends the credential in all of them - but the other
 * teams are somebody else's business, sometimes literally (a member here need
 * not belong to them), so neither the row nor the dialog names them. The dialog
 * says the client stops everywhere without saying where everywhere is.
 *
 * No action on the empty state: connecting happens in the Connect tab, which is
 * one click away and already carries that button.
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
  // The client leaves the list on the click — its credential is already gone by
  // the time the mutation answers.
  const {
    visible: rows,
    remove,
    restore,
  } = useOptimisticRemove(connections, (c) => c.id);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Connected clients
          <InfoTip content="Revoking one deletes the credential, so the client stops working everywhere it was connected." />
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          Every AI agent that can act in this team, and what each one is allowed
          to do.
        </p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <EmptyState
            graphic={<RobotGraphic state="idle" className="h-28" />}
            title="No agents connected"
            description="Anything you connect from the Connect tab shows up here, with a way to take its access away."
          />
        ) : (
          <div className="divide-y divide-border rounded-lg border border-border">
            {rows.map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between gap-4 p-3"
              >
                <div className="min-w-0 space-y-1">
                  <p className="flex items-center gap-2 truncate text-sm font-medium">
                    {c.clientName}
                    <Badge variant="outline" className="shrink-0 font-normal">
                      {c.kind === "web" ? "Web app" : "Token"}
                    </Badge>
                    {c.expired && (
                      <Badge
                        variant="outline"
                        className="shrink-0 border-[var(--warning)]/40 font-normal text-[var(--warning)]"
                      >
                        Expired
                      </Badge>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {describe(c)}
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
        // The credential is deleted, so the client stops in every team the same
        // consent approved - said without naming them, which is not this
        // screen's business.
        description="The credential is deleted: the client loses access immediately, in every team it was connected to, and has to be connected again to come back."
        confirmLabel="Revoke"
        successMessage="Access revoked"
        optimistic
        onConfirm={async () => {
          const id = revoke!.id;
          remove(id);
          const res = await gqlAction(
            `mutation($id: String!) { revokeToken(id: $id) }`,
            { id },
          );
          if (!res.ok) restore(id);
          router.refresh();
          return res;
        }}
      />
    </Card>
  );
}

/**
 * The second line: who let it in, where it came from, what it can do, when it
 * last spoke.
 *
 * `mcpLastUsedAt` and not `lastUsedAt`: this list is about agents, and a token
 * that ran a CI job an hour ago has not been an agent since Tuesday. A web
 * connector approved thirty seconds ago has neither, and says so.
 */
function describe(c: McpConnectionDTO): string {
  const parts = [
    c.username ? `Connected by ${c.username}` : "Connected",
    ...(c.kind === "web" && c.redirectOrigin ? [c.redirectOrigin] : []),
    `${c.capabilities.length} permission${c.capabilities.length === 1 ? "" : "s"}`,
    c.mcpLastUsedAt ? `active ${timeAgo(c.mcpLastUsedAt)}` : "not used yet",
  ];
  return parts.join(" · ");
}
