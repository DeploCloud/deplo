"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// useLayoutEffect on the client (measure before paint, no flash), useEffect on
// the server (a layout effect there would warn). Renamed so the exhaustive-deps
// lint doesn't try to police the caller-supplied dependency array.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

export interface UnderlineRect {
  left: number;
  width: number;
}

/**
 * Track the position + width of the active element inside a container so a single
 * underline can SLIDE between tabs instead of each tab toggling its own static
 * underline. Re-measures when `deps` change, when the container resizes, and —
 * when `watchAttributes` is set — when a descendant's `data-state` flips (Radix
 * tabs mark the active trigger that way, so no value plumbing is needed).
 */
export function useSlidingUnderline(
  containerRef: React.RefObject<HTMLElement | null>,
  getActive: () => HTMLElement | null,
  deps: React.DependencyList,
  watchAttributes = false,
): UnderlineRect | null {
  const [rect, setRect] = React.useState<UnderlineRect | null>(null);

  useIsoLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const el = getActive();
      if (!el) {
        setRect((prev) => (prev === null ? prev : null));
        return;
      }
      const left = el.offsetLeft;
      const width = el.offsetWidth;
      // Keep the same object when nothing moved so we don't re-render in a loop
      // (ResizeObserver fires once on observe).
      setRect((prev) =>
        prev && prev.left === left && prev.width === width
          ? prev
          : { left, width },
      );
    };

    measure();

    const ro = new ResizeObserver(measure);
    ro.observe(container);

    let mo: MutationObserver | undefined;
    if (watchAttributes) {
      mo = new MutationObserver(measure);
      mo.observe(container, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-state"],
      });
    }

    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, deps);

  return rect;
}

/** The sliding underline itself — absolutely positioned at the bottom of a
 *  `relative` tab bar. Animates its x-offset and width between tabs. */
export function SlidingUnderline({
  rect,
  className,
}: {
  rect: UnderlineRect | null;
  className?: string;
}) {
  if (!rect) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-foreground transition-[transform,width] duration-300 ease-out",
        className,
      )}
      style={{ transform: `translateX(${rect.left}px)`, width: rect.width }}
    />
  );
}
