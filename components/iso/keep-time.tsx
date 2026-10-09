"use client";

import * as React from "react";

let origin: CSSNumberish | null = null;
let mounted = 0;

/** Runs the art's animations on one clock, so the loading skeleton handing over
 *  to the page continues them instead of replaying the intro. */
export function KeepTime({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLSpanElement>(null);
  React.useLayoutEffect(() => {
    mounted++;
    origin ??= document.timeline.currentTime;
    for (const a of ref.current?.getAnimations({ subtree: true }) ?? []) {
      a.startTime = origin;
    }
    return () => {
      mounted--;
      // The skeleton unmounts in the same commit the page mounts in.
      queueMicrotask(() => {
        if (mounted === 0) origin = null;
      });
    };
  }, []);
  return (
    <span ref={ref} className="contents">
      {children}
    </span>
  );
}
