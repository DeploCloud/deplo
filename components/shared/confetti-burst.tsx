import type * as React from "react";
import { cn } from "@/lib/utils";

/** Twelve reads as a burst beside a picture; a screenful needs more than that. */
const CONFETTI = 12;

/**
 * The one-shot celebration for something that actually happened - an agent
 * connecting, a migration landing.
 */
export function ConfettiBurst({
  className,
  count = CONFETTI,
  /**
   * How far the nearest pieces fly, in px. Sized for a burst over an
   * illustration; ignored in `rain`, where the geometry is the window.
   */
  spread = 46,
  /**
   * Rain the pieces down the whole window instead of throwing them from one point.
   */
  rain = false,
}: {
  className?: string;
  count?: number;
  spread?: number;
  rain?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none motion-reduce:hidden",
        rain
          ? "deplo-confetti-rain fixed inset-0 overflow-hidden"
          : "absolute top-1/2 left-1/2 size-0",
        className,
      )}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="deplo-confetti-piece"
          style={
            rain
              ? ({
                  "--i": i,
                  // 37 is coprime with 100, so consecutive pieces land far apart and the column
                  // positions never repeat before the hundredth.
                  "--deplo-confetti-x": `${(i * 37) % 100}%`,
                  "--deplo-confetti-drift": `${((i % 5) - 2) * 26}px`,
                  "--deplo-confetti-t": `${(2.2 + (i % 4) * 0.45).toFixed(2)}s`,
                } as React.CSSProperties)
              : ({
                  "--i": i,
                  // The angle fans the pieces evenly over a full circle whatever `count` is; the
                  // small offset stops the first one flying due east, which reads as an arrow rather
                  // than a burst.
                  "--deplo-confetti-a": `${(i / count + 0.02).toFixed(4)}turn`,
                  "--deplo-confetti-d": `${Math.round(spread + (i % 3) * spread * 0.35)}px`,
                } as React.CSSProperties)
          }
        />
      ))}
    </span>
  );
}
