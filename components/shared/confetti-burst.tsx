import type * as React from "react";
import { cn } from "@/lib/utils";

/** Twelve reads as a burst beside a picture; a screenful needs more than that. */
const CONFETTI = 12;

/**
 * The one-shot celebration for something that actually happened - an agent
 * connecting, a migration landing, a first deploy landing.
 */
export function ConfettiBurst({
  className,
  count = CONFETTI,
  /**
   * How far the nearest pieces fly, in px. Sized for a burst over an
   * illustration; ignored in `rain` and `cannons`, where the geometry is the window.
   */
  spread = 46,
  /**
   * Rain the pieces down the whole window instead of throwing them from one point.
   */
  rain = false,
  /**
   * Fire from the two bottom corners toward the middle, the way a party popper
   * goes off on each side of a stage.
   */
  cannons = false,
}: {
  className?: string;
  count?: number;
  spread?: number;
  rain?: boolean;
  cannons?: boolean;
}) {
  const windowWide = rain || cannons;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none motion-reduce:hidden",
        windowWide
          ? "fixed inset-0 overflow-hidden"
          : "absolute top-1/2 left-1/2 size-0",
        rain && "deplo-confetti-rain",
        cannons && "deplo-confetti-cannons",
        className,
      )}
    >
      {Array.from({ length: count }, (_, i) => (
        <span
          key={i}
          className="deplo-confetti-piece"
          style={
            cannons
              ? cannonPiece(i)
              : rain
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

/**
 * One piece of the two-cannon burst: odd pieces start at the right edge and
 * travel left, so both corners fire the same shape mirrored. 13 and 17 are
 * coprime with the spans they wrap, which keeps consecutive pieces off each
 * other's arc.
 */
function cannonPiece(i: number): React.CSSProperties {
  const fromRight = i % 2 === 1;
  return {
    "--i": i,
    "--deplo-confetti-x": fromRight ? "100%" : "0%",
    "--deplo-confetti-vx": `${(fromRight ? -1 : 1) * (26 + ((i * 13) % 58))}vw`,
    "--deplo-confetti-vy": `${34 + ((i * 17) % 40)}vh`,
    "--deplo-confetti-t": `${(1.9 + (i % 5) * 0.28).toFixed(2)}s`,
  } as React.CSSProperties;
}
