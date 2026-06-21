"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

// useLayoutEffect on the client (measure before paint, no flash), useEffect on
// the server (a layout effect there would warn). Renamed so the exhaustive-deps
// lint doesn't try to police the caller-supplied dependency array.
const useIsoLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

export interface SlideRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/**
 * Track the box of the active element inside a container (relative to the
 * container) so a single highlight can SLIDE between items instead of each item
 * toggling its own. Re-measures when `deps` change, when the container resizes,
 * and — when `watchAttributes` is set — when a descendant's `data-state` flips
 * (Radix tabs mark the active trigger that way, so no value plumbing is needed).
 * Measured with getBoundingClientRect so it works regardless of offsetParent.
 */
export function useSlidingRect(
  containerRef: React.RefObject<HTMLElement | null>,
  getActive: () => HTMLElement | null,
  deps: React.DependencyList,
  watchAttributes = false,
): SlideRect | null {
  const [rect, setRect] = React.useState<SlideRect | null>(null);

  useIsoLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const el = getActive();
      if (!el) {
        setRect((prev) => (prev === null ? prev : null));
        return;
      }
      const c = container.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const next: SlideRect = {
        top: r.top - c.top,
        left: r.left - c.left,
        width: r.width,
        height: r.height,
      };
      // Keep the same object when nothing moved so we don't re-render in a loop
      // (ResizeObserver fires once on observe).
      setRect((prev) =>
        prev &&
        prev.top === next.top &&
        prev.left === next.left &&
        prev.width === next.width &&
        prev.height === next.height
          ? prev
          : next,
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

/** The sliding underline — absolutely positioned at the bottom of a `relative`
 *  tab bar. Animates its x-offset and width between tabs. */
export function SlidingUnderline({
  rect,
  className,
}: {
  rect: SlideRect | null;
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

/** A sliding background "pill" — sits behind the active item in a `relative
 *  isolate` list and translates/resizes to it. Used for the sidebar nav so the
 *  selected item's background glides between entries on navigation. */
export function SlidingBackground({
  rect,
  className,
}: {
  rect: SlideRect | null;
  className?: string;
}) {
  if (!rect) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute left-0 top-0 z-0 rounded-md bg-sidebar-accent transition-[transform,width,height] duration-200 ease-out",
        className,
      )}
      style={{
        transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`,
        width: rect.width,
        height: rect.height,
      }}
    />
  );
}
