"use client";

import { SimpleTooltip } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/utils";

/**
 * A relative timestamp, with the absolute one in its tooltip. The string is
 * computed twice - server render, then hydration - so a row seconds old renders
 * differently in each; `suppressHydrationWarning` is what tells React that gap is
 * the point, not a mismatch to regenerate the tree over.
 */
export function TimeAgo({ at }: { at: string }) {
  return (
    <SimpleTooltip content={new Date(at).toLocaleString()}>
      <span suppressHydrationWarning>{timeAgo(at)}</span>
    </SimpleTooltip>
  );
}
