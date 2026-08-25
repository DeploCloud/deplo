import { cn } from "@/lib/utils";

/** The "no templates match" illustration: a lens sweeping a row of templates, each one going out as it passes, until the row is empty and the sweep starts again. */
export function NoResultsGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="A magnifying glass sweeping across a row of templates, finding none"
      className={cn("size-32", className)}
    >
      <line
        x1="16"
        y1="82"
        x2="104"
        y2="82"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <g className="deplo-find-row">
        {[
          { x: 26, color: "var(--chart-1)" },
          { x: 43, color: "var(--chart-2)" },
          { x: 60, color: "var(--chart-3)" },
          { x: 77, color: "var(--chart-4)" },
          { x: 94, color: "var(--chart-5)" },
        ].map((dot, i) => (
          <circle
            key={dot.x}
            cx={dot.x}
            cy="64"
            r="7"
            fill={dot.color}
            className="deplo-find-dot"
            style={{ animationDelay: `${i * 0.24}s` }}
          />
        ))}
      </g>

      {/* The lens. It fades in at the left edge and out at the right one rather
          than snapping back, so the loop has no seam. */}
      <g className="deplo-find-lens">
        {/* No fill at all: you have to be able to see the row THROUGH the
            glass, or this is a disc that eats templates rather than a lens
            that looks at them. The glint below is what says "glass"; a tinted
            disc would have to be white at a few percent, which this repo does
            not draw. */}
        <circle
          cx="60"
          cy="60"
          r="21"
          className="stroke-primary"
          strokeWidth="3"
        />
        <line
          x1="75"
          y1="75"
          x2="88"
          y2="88"
          className="stroke-primary"
          strokeWidth="4"
          strokeLinecap="round"
        />
        {/* The glint: what tells you it is glass and not a ring. */}
        <path
          d="M50 52a12 12 0 0 1 8-6"
          className="stroke-background"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
