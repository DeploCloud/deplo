"use client";

import * as React from "react";
import { usePathname } from "@/lib/nav";
import { flatPath } from "@/lib/team-path";

const DEPTH_KEY = "__deploNavDepth";

let depth = 0;
let known = false;
let lastPath: string | null = null;
let stack: (string | null)[] = [];
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
  } catch {}
}

export function record(pathname: string): void {
  navigating = false;
  if (pathname === lastPath) return;
  lastPath = pathname;

  const stamped = readStamp();
  const first = !known;
  const prev = depth;

  let next: number;
  let pushed = false;
  if (stamped === undefined) {
    if (first) {
      next = 0;
    } else {
      next = prev + 1;
      pushed = true;
    }
    stamp(next);
  } else if (first) {
    next = stamped;
  } else if (stamped === prev) {
    next = prev + 1;
    pushed = true;
    stamp(next);
  } else {
    next = stamped;
  }

  if (first) {
    stack = new Array(next + 1).fill(null);
  } else if (pushed) {
    stack.length = next;
  }
  stack[next] = pathname;

  depth = next;
  known = true;
}

function isUnder(path: string, prefix: string): boolean {
  const flat = flatPath(path);
  return flat === prefix || flat.startsWith(prefix + "/");
}

const TRANSIENT_PREFIXES = ["/new", "/templates"];

function jump(delta: number): "jumped" {
  navigating = true;
  setTimeout(() => {
    navigating = false;
  }, 1000);
  window.history.go(delta);
  return "jumped";
}

type NavigationEntries = {
  currentEntry: { index: number } | null;
  entries(): { url: string | null }[];
};

// The browser's own list of entries, when it has one: a same-URL push or a state another
// replaceState wiped can't throw it off, unlike the stamps below.
function backOutOfEntries(
  nav: NavigationEntries,
  prefix: string,
): "jumped" | "none" {
  const entries = nav.entries();
  const current = nav.currentEntry!.index;
  for (let i = current - 1; i >= 0; i--) {
    const url = entries[i]?.url;
    if (!url) return "none";
    const p = new URL(url).pathname;
    if (TRANSIENT_PREFIXES.some((t) => isUnder(p, t))) continue;
    if (!isUnder(p, prefix)) return jump(i - current);
  }
  return "none";
}

export function backOutOf(prefix: string): "jumped" | "busy" | "none" {
  if (navigating) return "busy";

  const nav = (window as { navigation?: NavigationEntries }).navigation;
  if (nav?.currentEntry) return backOutOfEntries(nav, prefix);

  const stamped = readStamp();
  const current = typeof stamped === "number" ? stamped : known ? depth : null;
  if (current == null) return "none";

  for (let i = current - 1; i >= 0; i--) {
    const p = stack[i];
    if (p == null) return "none";
    if (TRANSIENT_PREFIXES.some((t) => isUnder(p, t))) continue;
    if (!isUnder(p, prefix)) return jump(i - current);
  }
  return "none";
}

export function NavigationHistoryTracker(): null {
  const pathname = usePathname();
  React.useEffect(() => {
    record(pathname);
  }, [pathname]);
  return null;
}
