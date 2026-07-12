"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

/**
 * "Smart back" for the sidebar sub-menu back links.
 *
 * A sub-menu back link ("Back to apps", "Back to dashboard") should EXIT
 * the current section — settings, or one app — and return you to the last
 * page you were on *before* you entered it, using the browser's own history.
 * Stepping one entry at a time (a plain back) would just walk between sibling
 * pages inside the section (settings/notifications → settings/account); instead
 * we skip the whole section in one jump. When there is no earlier in-app page
 * outside the section (a fresh tab, a deep link, a reload) the link falls back
 * to its href.
 *
 * We track the app's own history as a stack of visited pathnames indexed by a
 * monotonic depth stamped into `window.history.state`. Next preserves custom
 * history-state keys and, on a push, copies the current entry's state onto the
 * new one (`preserveCustomHistoryState`), so the stamp lets us tell a pushed
 * entry (inherits the previous depth → one deeper) from a popped one (keeps its
 * own depth). The stack then lets a back link find the nearest earlier entry
 * outside a given path prefix and jump straight to it with `history.go()`.
 */

const DEPTH_KEY = "__deploNavDepth";

// Module-level singleton — survives the back links mounting/unmounting between
// menus and is shared by the desktop and mobile sidebars. `stack[d]` is the
// pathname we recorded at depth `d`; a null means "not known" (e.g. entries
// that predate a reload, whose paths we can't recover).
let depth = 0;
let known = false;
let lastPath: string | null = null;
let stack: (string | null)[] = [];
// True while a history.go() jump is in flight, so a rapid second click can't
// fire another jump — and walk out of the app — before the first one lands.
let navigating = false;

function readStamp(): number | undefined {
  const state = window.history.state as Record<string, unknown> | null;
  const v = state?.[DEPTH_KEY];
  return typeof v === "number" ? v : undefined;
}

function stamp(value: number): void {
  const state = window.history.state as Record<string, unknown> | null;
  try {
    window.history.replaceState({ ...state, [DEPTH_KEY]: value }, "");
  } catch {
    /* replaceState can throw in rare sandboxed contexts — degrade gracefully */
  }
}

/**
 * Record the entry we've just landed on and update `depth`/`stack`. Deduped on
 * the pathname so React Strict Mode's double-invoked effect (or both sidebars
 * mounting) can't count one entry twice.
 */
function record(pathname: string): void {
  navigating = false; // a settled navigation ends any in-flight back jump
  if (pathname === lastPath) return;
  lastPath = pathname;

  const stamped = readStamp();
  const first = !known;
  const prev = depth;

  let next: number;
  let pushed = false;
  if (stamped === undefined) {
    // No stamp: the entry point (depth 0), or a pushed entry that didn't inherit
    // one — either way, one level deeper than where we were.
    if (first) {
      next = 0;
    } else {
      next = prev + 1;
      pushed = true;
    }
    stamp(next);
  } else if (first) {
    // First record onto an already-stamped entry: a reload restored this entry's
    // depth. Earlier depths are unknown — memory was wiped.
    next = stamped;
  } else if (stamped === prev) {
    // A pushed entry inherited the previous entry's stamp → one deeper.
    next = prev + 1;
    pushed = true;
    stamp(next);
  } else {
    // A back/forward pop carries its own stamp → adopt it.
    next = stamped;
  }

  if (first) {
    // Rebuild the stack; only this depth's pathname is known.
    stack = new Array(next + 1).fill(null);
  } else if (pushed) {
    // A push discards the forward entries the browser just dropped.
    stack.length = next;
  }
  stack[next] = pathname;

  depth = next;
  known = true;
}

function isUnder(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix + "/");
}

/**
 * Exit the section identified by `prefix` (e.g. "/settings" or "/apps/abc"):
 * jump to the nearest earlier in-app entry whose pathname is outside that
 * prefix. Returns:
 *   "jumped" — a history.go() was fired (caller should suppress the href)
 *   "busy"   — a jump is already in flight (caller should ignore the click)
 *   "none"   — no such entry is known (caller should follow the fallback href)
 */
export function backOutOf(prefix: string): "jumped" | "busy" | "none" {
  if (navigating) return "busy";

  // Trust the live stamp on the current entry for our position: it's correct
  // even in the brief window after a pop/push before the tracker effect re-runs,
  // so we can never over-jump past the app's own entry.
  const stamped = readStamp();
  const current = typeof stamped === "number" ? stamped : known ? depth : null;
  if (current == null) return "none";

  for (let i = current - 1; i >= 0; i--) {
    const p = stack[i];
    if (p == null) return "none"; // unknown (post-reload) → fall back to the href
    if (!isUnder(p, prefix)) {
      navigating = true;
      // Failsafe: release the lock even if the expected popstate never records.
      setTimeout(() => {
        navigating = false;
      }, 1000);
      window.history.go(i - current); // negative: jump straight out of the section
      return "jumped";
    }
  }
  return "none";
}

/** Mounted once in the app shell; records every route change. */
export function NavigationHistoryTracker(): null {
  const pathname = usePathname();
  React.useEffect(() => {
    record(pathname);
  }, [pathname]);
  return null;
}
