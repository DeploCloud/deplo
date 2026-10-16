"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { gsap, useGSAP } from "@/lib/gsap";

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
        attributeFilter: [
          "data-state",
          "data-active",
          "aria-pressed",
          "aria-selected",
          "aria-current",
        ],
      });
    }

    return () => {
      ro.disconnect();
      mo?.disconnect();
    };
  }, deps);

  return rect;
}

function SlidingIndicator({
  rect,
  className,
  underline = false,
}: {
  rect: SlideRect | null;
  className?: string;
  underline?: boolean;
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const positioned = React.useRef(false);

  useGSAP(
    () => {
      if (!ref.current) return;
      if (!rect) {
        positioned.current = false;
        gsap.set(ref.current, { autoAlpha: 0, overwrite: true });
        return;
      }
      const target = {
        x: rect.left,
        width: rect.width,
        autoAlpha: 1,
        ...(underline ? {} : { y: rect.top, height: rect.height }),
      };
      if (
        !positioned.current ||
        window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ) {
        gsap.set(ref.current, { ...target, overwrite: true });
      } else {
        gsap.to(ref.current, {
          ...target,
          duration: 0.3,
          ease: "power3.out",
          overwrite: true,
        });
      }
      positioned.current = true;
    },
    { dependencies: [rect, underline] },
  );

  return (
    <span
      ref={ref}
      aria-hidden
      className={cn(
        "pointer-events-none absolute left-0",
        underline
          ? "bottom-0 h-0.5 rounded-full bg-foreground"
          : "top-0 z-0 rounded-md bg-sidebar-accent",
        className,
      )}
      style={{ visibility: "hidden" }}
    />
  );
}

export function SlidingUnderline({
  rect,
  className,
}: {
  rect: SlideRect | null;
  className?: string;
}) {
  return <SlidingIndicator rect={rect} className={className} underline />;
}

export function SlidingBackground({
  rect,
  className,
}: {
  rect: SlideRect | null;
  className?: string;
}) {
  return <SlidingIndicator rect={rect} className={className} />;
}
