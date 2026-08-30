"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

// The sidebar icon already spins at 150ms; the bar is the second stage, for a
// navigation the server is taking long enough over that a 16px spinner in the
// corner no longer carries it.
const APPEAR_AFTER_MS = 500;
const FADE_OUT_MS = 250;
const GIVE_UP_MS = 30_000;

type Phase = "idle" | "running" | "done";

/**
 * Does following `href` from `here` load a new page in this tab? False for
 * another origin and for a link back to the page we are already on, which
 * includes a bare `#anchor` - neither ever finishes, so neither may start a bar.
 */
export function leavesThisPage(href: string, here: string): boolean {
  let to: URL, from: URL;
  try {
    from = new URL(here);
    to = new URL(href, here);
  } catch {
    return false;
  }
  if (to.origin !== from.origin) return false;
  return to.pathname + to.search !== from.pathname + from.search;
}

/**
 * A left click that this tab is going to handle as an in-app navigation. Note
 * what is NOT checked: `defaultPrevented`, because `next/link` prevents the
 * default on every in-app click, which is the case we are here for.
 */
function navigates(e: MouseEvent): boolean {
  if (e.button !== 0) return false;
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return false;
  const anchor = (e.target as Element | null)?.closest?.(
    "a[href]",
  ) as HTMLAnchorElement | null;
  if (!anchor || anchor.hasAttribute("download")) return false;
  if (anchor.target && anchor.target !== "_self") return false;
  return leavesThisPage(anchor.href, location.href);
}

/**
 * The bar across the top of the window while a page loads. Most routes never
 * reach it: it waits out `APPEAR_AFTER_MS` first, so only a slow one is ever
 * announced.
 */
export function NavProgress() {
  const pathname = usePathname();
  const query = useSearchParams().toString();
  const [phase, setPhase] = React.useState<Phase>("idle");
  const timers = React.useRef<ReturnType<typeof setTimeout>[]>([]);

  const after = React.useCallback((ms: number, fn: () => void) => {
    timers.current.push(setTimeout(fn, ms));
  }, []);

  const clear = React.useCallback(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  }, []);

  // The page landed (or never will). A bar already on screen completes and
  // fades; one still inside its delay is dropped without ever being drawn.
  const inFlight = React.useRef(false);
  const finish = React.useCallback(() => {
    if (!inFlight.current) return;
    inFlight.current = false;
    clear();
    setPhase((p) => (p === "running" ? "done" : "idle"));
    after(FADE_OUT_MS, () => setPhase("idle"));
  }, [after, clear]);

  React.useEffect(() => finish(), [pathname, query, finish]);

  React.useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (!navigates(e)) return;
      clear();
      inFlight.current = true;
      after(APPEAR_AFTER_MS, () => setPhase("running"));
      after(GIVE_UP_MS, finish);
    };
    document.addEventListener("click", onClick);
    return () => {
      document.removeEventListener("click", onClick);
      clear();
    };
  }, [after, clear, finish]);

  if (phase === "idle") return null;

  return (
    <div
      role="progressbar"
      aria-label="Loading"
      className="pointer-events-none fixed inset-x-0 top-0 z-[70] h-0.5"
    >
      <div
        className={cn(
          "h-full origin-left scale-x-100 bg-foreground",
          phase === "running"
            ? "deplo-nav-progress"
            : "deplo-nav-progress-done",
        )}
      />
    </div>
  );
}
