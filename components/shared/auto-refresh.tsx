"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";

/** How often a page with work in flight re-reads itself. */
const DEFAULT_INTERVAL_MS = 5_000;

/**
 * Re-run the page's RSC reads while something on it is still moving: a backup
 * writes its `running` row minutes before the mutation resolves, so the table
 * would otherwise sit frozen on what it read at load. Mount it with `active` for
 * as long as there is something to watch; ticks are skipped on a hidden tab.
 *
 * ponytail: each instance owns its own timer, so N rows ask for N refreshes per
 *   tick. Hoist to one instance driven by a count if a page ever needs dozens.
 */
export function AutoRefresh({
  active,
  intervalMs = DEFAULT_INTERVAL_MS,
}: {
  active: boolean;
  intervalMs?: number;
}) {
  const router = useRouter();
  React.useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
