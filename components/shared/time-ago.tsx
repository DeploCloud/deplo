"use client";

import { useSyncExternalStore } from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { subscribeToTick, tickNow } from "@/lib/tick";
import { timeAgo, timeAgoShort } from "@/lib/utils";

/**
 * The reader's clock, ticking: ONE interval for the page however many timestamps
 * sit on it, and none at all once the last one unmounts.
 */
export function useNow(): number {
  return useSyncExternalStore(subscribeToTick, tickNow, () => 0);
}

/**
 * A relative timestamp, with the absolute one in its tooltip. The string is
 * computed twice - server render, then hydration - so a row seconds old renders
 * differently in each; `suppressHydrationWarning` is what tells React that gap is
 * the point, not a mismatch to regenerate the tree over.
 */
export function TimeAgo({
  at,
  short = false,
  className,
}: {
  at: string | number;
  short?: boolean;
  className?: string;
}) {
  useNow();
  return (
    <SimpleTooltip content={new Date(at).toLocaleString()}>
      <span className={className} suppressHydrationWarning>
        {short ? timeAgoShort(at) : timeAgo(at)}
      </span>
    </SimpleTooltip>
  );
}
