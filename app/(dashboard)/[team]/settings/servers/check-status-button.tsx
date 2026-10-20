"use client";

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useServerHealth } from "./server-health-provider";

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

export function RefreshFleetButton() {
  const { checkAll, sweeping } = useServerHealth();

  return (
    <SimpleTooltip content="Re-check every server">
      <Button
        variant="outline"
        size="sm"
        onClick={checkAll}
        disabled={sweeping}
      >
        <RefreshCw className={sweeping ? "size-4 animate-spin" : "size-4"} />
        {sweeping ? "Refreshing" : "Refresh"}
      </Button>
    </SimpleTooltip>
  );
}
