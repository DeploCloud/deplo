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

export function backOutOf(prefix: string): "jumped" | "busy" | "none" {
  if (navigating) return "busy";

  const stamped = readStamp();
  const current = typeof stamped === "number" ? stamped : known ? depth : null;
  if (current == null) return "none";

  for (let i = current - 1; i >= 0; i--) {
    const p = stack[i];
    if (p == null) return "none";
    if (TRANSIENT_PREFIXES.some((t) => isUnder(p, t))) continue;
    if (!isUnder(p, prefix)) {
      navigating = true;
      setTimeout(() => {
        navigating = false;
      }, 1000);
      window.history.go(i - current);
      return "jumped";
    }
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
