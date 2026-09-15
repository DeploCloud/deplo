import type * as React from "react";
import { cn } from "@/lib/utils";

const CONFETTI = 12;

export function ConfettiBurst({
  className,
  count = CONFETTI,
  spread = 46,
  rain = false,
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
                    "--deplo-confetti-x": `${(i * 37) % 100}%`,
                    "--deplo-confetti-drift": `${((i % 5) - 2) * 26}px`,
                    "--deplo-confetti-t": `${(2.2 + (i % 4) * 0.45).toFixed(2)}s`,
                  } as React.CSSProperties)
                : ({
                    "--i": i,
                    "--deplo-confetti-a": `${(i / count + 0.02).toFixed(4)}turn`,
                    "--deplo-confetti-d": `${Math.round(spread + (i % 3) * spread * 0.35)}px`,
                  } as React.CSSProperties)
          }
        />
      ))}
    </span>
  );
}

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
