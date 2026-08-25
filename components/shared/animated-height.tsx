"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A dialog body that is the height of its CONTENT and eases between sizes, so a
 * form that swaps a branch (or a wizard that swaps a step) reads as the same
 * dialog growing rather than a new one being drawn over the old one.
 */
export function AnimatedHeight({
  children,
  className,
}: {
  children: React.ReactNode;
  /** Layout of the measured inner box - the content's own spacing. */
  className?: string;
}) {
  const [el, setEl] = React.useState<HTMLDivElement | null>(null);
  const [height, setHeight] = React.useState<number>();
  const measured = React.useRef<number>(undefined);
  const [growing, setGrowing] = React.useState(false);
  const [scrolls, setScrolls] = React.useState(false);

  React.useLayoutEffect(() => {
    if (!el) return;
    // An observer, not a one-shot read: the body also grows WITHIN a branch - a
    // warning appearing, an Advanced section opening, a validation line, and
    // those deserve the same easing.
    const ro = new ResizeObserver(() => {
      const h = el.getBoundingClientRect().height;
      if (measured.current === h) return;
      const first = measured.current === undefined;
      measured.current = h;
      setHeight(h);
      setScrolls(h > window.innerHeight * 0.75);
      if (!first) setGrowing(true);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);

  return (
    <div
      className={cn(
        "transition-[height] duration-300 ease-out motion-reduce:transition-none",
        scrolls
          ? "focus-safe-scroll max-h-[75vh] overflow-y-auto"
          : growing
            ? "overflow-hidden"
            : "overflow-visible",
      )}
      style={{ height }}
      onTransitionEnd={(e) => e.propertyName === "height" && setGrowing(false)}
    >
      <div ref={setEl} className={className}>
        {children}
      </div>
    </div>
  );
}
