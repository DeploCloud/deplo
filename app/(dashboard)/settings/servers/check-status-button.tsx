"use client";

import { RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { useServerHealth } from "./server-health-provider";

/**
 * "Check status" — re-probe ONE server's agent on demand. The page already sweeps the
 * fleet on load; this is for the operator who just restarted a box and doesn't want to
 * wait out the throttle or reload the page. It forces past the ambient 15s window (a
 * short server-side floor still applies, so a mashed button can't fan out dials).
 *
 * Sits next to the per-card actions menu rather than inside it: an operator on this page
 * is usually here BECAUSE a server looks wrong, and burying the one action that answers
 * "is it still wrong?" behind a menu would be the wrong default.
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
 * "Check all" — force a fresh probe of every server (the header action, alongside
 * "Check for updates"). Distinct from the page's automatic on-load sweep, which is
 * throttled; this one the operator asked for explicitly.
 */
export function CheckAllStatusButton() {
  const { checkAll, sweeping } = useServerHealth();

  return (
    <Button variant="outline" size="sm" onClick={() => checkAll()} disabled={sweeping}>
      <RefreshCw className={sweeping ? "size-4 animate-spin" : "size-4"} />
      {sweeping ? "Checking…" : "Check status"}
    </Button>
  );
}
