"use client";

import * as React from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/utils";

/**
 * A relative timestamp, with the absolute one in its tooltip. The string is
 * computed twice - server render, then hydration - so a row seconds old renders
 * differently in each; `suppressHydrationWarning` is what tells React that gap is
 * the point, not a mismatch to regenerate the tree over.
 *
 * `live` re-counts every second, for a page watched while the thing it dates is
 * still happening. Everywhere else the stamp is written once and a reload moves it.
 */
export function TimeAgo({ at, live = false }: { at: string; live?: boolean }) {
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [live]);

  return (
    <SimpleTooltip content={new Date(at).toLocaleString()}>
      <span suppressHydrationWarning>{timeAgo(at)}</span>
    </SimpleTooltip>
  );
}
