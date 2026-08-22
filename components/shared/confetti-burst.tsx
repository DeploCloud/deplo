import type * as React from "react";
import { cn } from "@/lib/utils";

/** Twelve reads as a burst beside a picture; a screenful needs more than that. */
const CONFETTI = 12;

/**
 * The one-shot celebration for something that actually happened - an agent
 * connecting, a migration landing.
 *
 * Deliberately CSS and not a library: this is a 1.1s burst of spans, and pulling
 * in a canvas confetti package for it would put a second animation grammar in a
 * repo that has exactly one. Each piece takes its delay and colour from an `--i`
 * index and its angle and distance from two variables set here, so the whole
 * thing is still one keyframe however many pieces it throws.
 *
 * It renders nothing under `prefers-reduced-motion`: confetti is pure
 * decoration, and a person who asked for less motion is not owed a still frame
 * of it. Mount it only when the success arrives — it has no state and replays
 * by being remounted, which is what a `key` on the parent does for free.
 */
export function ConfettiBurst({
  className,
  count = CONFETTI,
  /**
   * How far the nearest pieces fly, in px. The default is sized for a burst
   * over an illustration; a celebration that should read across the whole
   * window passes a few hundred and raises `count` to match - the same number
   * of pieces spread ten times as wide is not a burst, it is a drizzle.
   */
  spread = 46,
}: {
  className?: string;
  count?: number;
  spread?: number;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute left-1/2 top-1/2 size-0 motion-reduce:hidden",
        className,
      )}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="deplo-confetti-piece"
          style={
            {
              "--i": i,
              // The angle fans the pieces evenly over a full circle whatever
              // `count` is; the small offset stops the first one flying due
              // east, which reads as an arrow rather than a burst. Three
              // distances in rotation so no two neighbours land together.
              "--deplo-confetti-a": `${(i / count + 0.02).toFixed(4)}turn`,
              "--deplo-confetti-d": `${Math.round(spread + (i % 3) * spread * 0.35)}px`,
            } as React.CSSProperties
          }
        />
      ))}
    </span>
  );
}
