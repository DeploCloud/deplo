import { cn } from "@/lib/utils";

/** The Overview empty-state illustration: a rocket sitting on its pad, lifting off, and coming back round for the next one. */
export function AppsGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A rocket lifting off from its launch pad"
      className={cn("size-32", className)}
    >
      <line
        x1="34"
        y1="78"
        x2="86"
        y2="78"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <g className="fill-border">
        <circle className="deplo-rocket-smoke" cx="42" cy="77" r="4" />
        <circle className="deplo-rocket-smoke" cx="78" cy="77" r="4" />
      </g>

      <g className="deplo-rocket">
        <g
          className="fill-card stroke-muted-foreground"
          strokeWidth="2"
          strokeLinejoin="round"
        >
          <path d="M51 56 L44 74 L51 70 Z" />
          <path d="M69 56 L76 74 L69 70 Z" />
        </g>

        <path
          className="deplo-rocket-flame"
          d="M54 64 Q60 92 66 64 Z"
          fill="var(--chart-4)"
        />

        <path
          d="M60 34 C67 42 69 54 69 66 H51 C51 54 53 42 60 34 Z"
          className="fill-card stroke-muted-foreground"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <circle
          cx="60"
          cy="50"
          r="4.5"
          className="stroke-ring"
          strokeWidth="2"
        />
      </g>
    </svg>
  );
}
