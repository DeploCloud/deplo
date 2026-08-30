"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
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
 * "Check all" - force a fresh probe of every server (the header action, alongside
 * "Check for updates"). Distinct from the page's automatic on-load sweep, which is
 * throttled; this one the operator asked for explicitly.
 */
export function CheckAllStatusButton() {
  const { checkAll, sweeping } = useServerHealth();

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => checkAll()}
      disabled={sweeping}
    >
      <RefreshCw className={sweeping ? "size-4 animate-spin" : "size-4"} />
      {sweeping ? "Checking…" : "Check status"}
    </Button>
  );
}
