"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

const useIsoLayoutEffect =
  typeof window !== "undefined" ? React.useLayoutEffect : React.useEffect;

export interface SlideRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

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
      const scale = c.width / container.offsetWidth || 1;
      const next: SlideRect = {
        top: (r.top - c.top) / scale + container.scrollTop,
        left: (r.left - c.left) / scale + container.scrollLeft,
        width: r.width / scale,
        height: r.height / scale,
      };
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
