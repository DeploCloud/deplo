"use client";

import * as React from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { timeAgo } from "@/lib/utils";

// TimeAgo - the string differs between server render and hydration, so suppressHydrationWarning is the point, not a mismatch.
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
