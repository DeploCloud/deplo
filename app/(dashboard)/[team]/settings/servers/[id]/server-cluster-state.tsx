"use client";

import { Countdown, useNow } from "@/components/shared/live-state";
import { useServerHealth } from "../server-health-provider";

// A cluster member gone offline leaves the others' answers once they stop hearing it (ADR-0049): counted down.
export function ServerClusterState({
  serverId,
  dropAfterMs,
}: {
  serverId: string;
  dropAfterMs: number;
}) {
  const { health } = useServerHealth();
  const h = health(serverId);
  const offline = h?.status === "offline";
  const now = useNow(offline);
  if (!offline || !h?.lastReachedAt) return null;
  const leaves = Date.parse(h.lastReachedAt) + dropAfterMs;
  return (
    <div className="max-w-md text-sm">
      {now < leaves ? (
        <Countdown
          until={leaves}
          total={dropAfterMs}
          label="Leaving its cluster's answers"
        />
      ) : (
        <p className="text-muted-foreground">
          Left its cluster&apos;s answers. Its Apps move to another server.
        </p>
      )}
    </div>
  );
}
