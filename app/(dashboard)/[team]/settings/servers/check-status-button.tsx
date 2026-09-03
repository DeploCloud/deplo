"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import { useServerHealth } from "./server-health-provider";

/**
 * "Check status" - re-probe ONE server's agent on demand. It forces past the
 * ambient 15s window (a short server-side floor still applies, so a mashed button
 * can't fan out dials). behind a menu would be the wrong default.
 */
export function CheckStatusButton({
  serverId,
  serverName,
}: {
  serverId: string;
  serverName: string;
}) {
  const { checkOne, isChecking } = useServerHealth();
  const pending = isChecking(serverId);

  return (
    <SimpleTooltip content={`Re-check ${serverName}'s agent now`} side="left">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 shrink-0"
        aria-label={`Check status of ${serverName}`}
        onClick={() => checkOne(serverId)}
        disabled={pending}
      >
        <RefreshCw className={pending ? "size-4 animate-spin" : "size-4"} />
      </Button>
    </SimpleTooltip>
  );
}

/**
 * The fleet's one refresh: re-probe every agent AND re-resolve the latest agent
 * release. Two buttons asked the operator to know which question they had.
 */
export function RefreshFleetButton() {
  const router = useRouter();
  const { checkAll, sweeping } = useServerHealth();
  const [pending, startTransition] = React.useTransition();
  const busy = sweeping || pending;

  function refresh() {
    void checkAll();
    startTransition(async () => {
      const res = await gqlAction<{ checkAgentUpdates: string }>(
        `mutation CheckAgentUpdates {
          checkAgentUpdates
        }`,
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      // Re-run the server-side reads so each server's "Update agent" points at
      // the freshly resolved version.
      router.refresh();
    });
  }

  return (
    <SimpleTooltip content="Re-check every agent and the latest agent release">
      <Button variant="outline" size="sm" onClick={refresh} disabled={busy}>
        <RefreshCw className={busy ? "size-4 animate-spin" : "size-4"} />
        {busy ? "Refreshing" : "Refresh"}
      </Button>
    </SimpleTooltip>
  );
}
