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
 * Track the active element's box inside a container so one highlight can SLIDE
 * between items. Re-measures on `deps`, on resize, and with `watchAttributes`
 * when a descendant's `data-state` flips (how Radix marks the active trigger).
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
        // Scroll offsets included on purpose: the highlight is positioned inside the
        // container's CONTENT box, which moves when the container scrolls (the tab strip
        // does, on a narrow screen).
        top: r.top - c.top + container.scrollTop,
        left: r.left - c.left + container.scrollLeft,
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
        "pointer-events-none absolute top-0 left-0 z-0 rounded-md bg-sidebar-accent transition-[transform,width,height] duration-200 ease-out",
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
