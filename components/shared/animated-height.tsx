"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

const TRANSITION_MS = 300;

export function AnimatedHeight({
  children,
  className,
  scroll = true,
}: {
  children: React.ReactNode;
  className?: string;
  scroll?: boolean;
}) {
  const [el, setEl] = React.useState<HTMLDivElement | null>(null);
  const [height, setHeight] = React.useState<number>();
  const measured = React.useRef<number>(undefined);
  const [growing, setGrowing] = React.useState(false);
  const [scrolls, setScrolls] = React.useState(false);
  const settle = React.useRef<ReturnType<typeof setTimeout>>(undefined);

  React.useLayoutEffect(() => () => clearTimeout(settle.current), []);

  React.useLayoutEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const h = entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
      if (measured.current === h) return;
      const first = measured.current === undefined;
      measured.current = h;
      setHeight(h);
      setScrolls(scroll && h > window.innerHeight * 0.75);
      if (first) return;
      setGrowing(true);
      clearTimeout(settle.current);
      settle.current = setTimeout(() => setGrowing(false), TRANSITION_MS + 50);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el, scroll]);

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
