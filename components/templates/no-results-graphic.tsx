import { cn } from "@/lib/utils";

/**
 * The "no templates match" illustration: a lens sweeping a row of templates,
 * each one going out as it passes, until the row is empty and the sweep starts
 * again.
 *
 * A crossed-out magnifier says "error"; a lens that keeps looking says "nothing
 * here yet, try another word", which is the only thing this state is about. The
 * dots are the catalogue's own colours (the chart series, the repo's one
 * categorical set) so the drawing reads as templates rather than as decoration.
 *
 * Same grammar as `CronGraphic` and `PullRequestGraphic`: recessive muted
 * structure, the subject in primary, pure SVG + CSS keyframes (see globals.css)
 * so it costs one paint, needs no JS and renders in a server component. Under
 * `prefers-reduced-motion` it holds the frame where the row has already gone
 * out — the state the drawing exists to show.
 */
export function NoResultsGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="A magnifying glass sweeping across a row of templates, finding none"
      className={cn("size-32", className)}
    >
      {/* The shelf the templates sat on. Never animated, so the eye follows the
          lens and not the furniture. */}
      <line
        x1="16"
        y1="82"
        x2="104"
        y2="82"
        className="stroke-muted-foreground/30"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The catalogue: five templates, in the five chart colours. Each goes out
          as the lens reaches it — the delay IS the lens's position, which is why
          one keyframe set serves all five. */}
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
        {/* Barely-there fill: you have to be able to see the row THROUGH the
            glass, or this is a disc that eats templates rather than a lens
            that looks at them. */}
        <circle
          cx="60"
          cy="60"
          r="21"
          className="fill-foreground/5 stroke-primary"
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
          opacity="0.7"
        />
      </g>
    </svg>
  );
}
