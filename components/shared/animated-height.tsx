"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/** Kept in step with the `duration-300` below. */
const TRANSITION_MS = 300;

/**
 * A dialog body that is the height of its CONTENT and eases between sizes, so a
 * form that swaps a branch (or a wizard that swaps a step) reads as the same
 * dialog growing rather than a new one being drawn over the old one.
 */
export function AnimatedHeight({
  children,
  className,
  scroll = true,
}: {
  children: React.ReactNode;
  /** Layout of the measured inner box - the content's own spacing. */
  className?: string;
  /**
   * Whether a tall body becomes a scroll box HERE. False when the child owns
   * its own scrolling - a card that caps its own height keeps its header and
   * footer put, and scrolling it from the outside would carry them away.
   */
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
    // An observer, not a one-shot read: the body also grows WITHIN a branch - a
    // warning appearing, an Advanced section opening, a validation line, and
    // those deserve the same easing.
    const ro = new ResizeObserver(([entry]) => {
      // borderBoxSize, not getBoundingClientRect: the dialog opens with a
      // `zoom-in-95` TRANSFORM, so the first measurement read 95% of the real
      // height and nothing ever re-fired to correct it.
      const h = entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight;
      if (measured.current === h) return;
      const first = measured.current === undefined;
      measured.current = h;
      setHeight(h);
      setScrolls(scroll && h > window.innerHeight * 0.75);
      if (first) return;
      setGrowing(true);
      // `transitionend` is the fast way out, but it never fires under reduced
      // motion, and then the clip stayed on for good - 3px off every focus ring
      // at the edges of every dialog and wizard step. This is the way out that
      // does not depend on an animation having happened.
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
