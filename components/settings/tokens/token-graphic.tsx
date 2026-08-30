import { cn } from "@/lib/utils";

/** The API tokens empty-state illustration: a key being cut, then turned in a lock that springs open. */
export function TokenGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="A key drawing itself, its teeth cut one after the other, then turning in a lock that opens"
      className={cn("size-32", className)}
    >
      <path
        className="deplo-token-shackle stroke-ring"
        d="M60 44V30a18 18 0 0 1 36 0v14"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <g className="deplo-token-key">
        <g className="deplo-token-insert">
          <g stroke="var(--chart-4)" strokeWidth="5" strokeLinecap="round">
            <circle
              className="deplo-token-draw"
              cx="15"
              cy="66"
              r="11"
              pathLength="1"
            />
            <line
              className="deplo-token-draw deplo-token-shaft"
              x1="24"
              y1="66"
              x2="48"
              y2="66"
              pathLength="1"
            />
          </g>

          <g fill="var(--chart-4)">
            <rect
              className="deplo-token-tooth"
              x="35"
              y="65"
              width="5"
              height="11"
              rx="2"
            />
            <rect
              className="deplo-token-tooth"
              x="42"
              y="65"
              width="5"
              height="15"
              rx="2"
            />
          </g>
        </g>
      </g>

      <rect
        x="50"
        y="42"
        width="56"
        height="48"
        rx="10"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />

      <g className="fill-ring">
        <circle cx="78" cy="63" r="4.5" />
        <path d="M75.5 66h5l1.5 9h-8Z" />
      </g>
    </svg>
  );
}
