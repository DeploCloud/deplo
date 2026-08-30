import { cn } from "@/lib/utils";

/** The Account page's mark: an ID badge with a padlock over its corner. */
export function AccountGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 96"
      fill="none"
      role="img"
      aria-label="An identity badge closed by a padlock"
      className={cn("size-24", className)}
    >
      <rect x="30" y="5" width="16" height="8" rx="4" className="fill-border" />
      <rect
        x="6"
        y="10"
        width="64"
        height="76"
        rx="10"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />

      <circle cx="38" cy="38" r="13" fill="var(--chart-1)" />
      <circle cx="38" cy="34.5" r="4.5" className="fill-card" />
      <path
        d="M30 47 C30 41.5 34 39 38 39 C42 39 46 41.5 46 47 Z"
        className="fill-card"
      />

      <g className="fill-border">
        <rect x="20" y="60" width="36" height="5" rx="2.5" />
        <rect x="26" y="70" width="24" height="5" rx="2.5" />
      </g>

      <path
        d="M70 68 V58 A7 7 0 0 1 84 58 V68"
        className="stroke-card"
        strokeWidth="9"
        strokeLinecap="round"
      />
      <path
        d="M70 68 V58 A7 7 0 0 1 84 58 V68"
        stroke="var(--success)"
        strokeWidth="4.5"
        strokeLinecap="round"
      />
      <rect
        x="64"
        y="64"
        width="26"
        height="22"
        rx="6"
        fill="var(--success)"
        paintOrder="stroke"
        className="stroke-card"
        strokeWidth="5"
      />
      <g className="fill-card">
        <circle cx="77" cy="72" r="3" />
        <rect x="75.5" y="72" width="3" height="7" rx="1.5" />
      </g>
    </svg>
  );
}
