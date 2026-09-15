"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";

const DEFAULT_INTERVAL_MS = 5_000;

// ponytail: each instance owns its own timer, so N rows ask for N refreshes per
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
