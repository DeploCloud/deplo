import { cn } from "@/lib/utils";

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

      <g className="deplo-find-lens">
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
