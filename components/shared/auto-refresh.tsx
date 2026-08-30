"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { useRouter } from "next/navigation";

/** How often a page with work in flight re-reads itself. */
const DEFAULT_INTERVAL_MS = 5_000;

/**
 * Re-run the page's RSC reads while something on it is still moving.
 *
 * A backup records its `running` row before the dump starts and flips it to a
 * terminal status minutes later, while the mutation that started it resolves
 * only at the very end - so without this the table sits frozen on whatever it
 * read when the page loaded, and a run someone else (or the scheduler) started
 * never appears at all.
 *
 * Mount it with `active` true for exactly as long as there is something to
 * watch; it stops on its own the moment the last runner settles. Ticks are
 * skipped while the tab is hidden, the same rule `DomainDnsAutoCheck` follows -
 * a background tab has nobody to show a fresher row to.
 *
 * ponytail: each mounted instance owns its own timer, so N rows running at once
 *   on one page ask for N refreshes per tick. Fine at the scale a backup list
 *   reaches; if a page ever needs dozens, hoist it to one instance driven by a
 *   count instead of mounting it per row.
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
