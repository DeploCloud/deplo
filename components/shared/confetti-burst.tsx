import type * as React from "react";
import { cn } from "@/lib/utils";

/** How many pieces the burst throws. Twelve reads as a burst; thirty reads as weather. */
const CONFETTI = 12;

/**
 * The one-shot celebration for something that actually happened - an agent
 * connecting, a migration landing.
 *
 * Deliberately CSS and not a library: this is a 1.1s burst of twelve spans, and
 * pulling in a canvas confetti package for it would put a second animation
 * grammar in a repo that has exactly one. Each piece takes its angle, distance,
 * delay and colour from an `--i` index, so the whole thing is one keyframe.
 *
 * It renders nothing under `prefers-reduced-motion`: confetti is pure
 * decoration, and a person who asked for less motion is not owed a still frame
 * of it. Mount it only when the success arrives — it has no state and replays
 * by being remounted, which is what a `key` on the parent does for free.
 */
export function ConfettiBurst({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute left-1/2 top-1/2 size-0 motion-reduce:hidden",
        className,
      )}
    >
      {Array.from({ length: CONFETTI }, (_, i) => (
        <span
          key={i}
          className="deplo-confetti-piece"
          style={{ "--i": i } as React.CSSProperties}
        />
      ))}
    </span>
  );
}
