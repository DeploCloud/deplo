import { cn } from "@/lib/utils";

/** The Security card's mark: a password, then a fingerprint, signed off by a shield. */
export function TwoFactorGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 272 80"
      fill="none"
      role="img"
      aria-label="A password field and a fingerprint, approved by a shield"
      className={cn("h-full w-full", className)}
    >
      {/* First factor: the password. */}
      <rect
        x="6"
        y="14"
        width="84"
        height="52"
        rx="12"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />
      <g className="fill-muted-foreground">
        <circle cx="27" cy="40" r="4" />
        <circle cx="41" cy="40" r="4" />
        <circle cx="55" cy="40" r="4" />
        <circle cx="69" cy="40" r="4" />
      </g>

      <g className="fill-ring">
        <rect x="98" y="37" width="14" height="5" rx="2.5" />
        <rect x="102.5" y="32.5" width="5" height="14" rx="2.5" />
      </g>

      {/* Second factor: the fingerprint. */}
      <rect
        x="120"
        y="14"
        width="84"
        height="52"
        rx="12"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />
      <g
        stroke="var(--chart-1)"
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M145 56 V50 A17 18 0 0 1 179 50 V56" />
        <path d="M150 55 V50 A12 13 0 0 1 174 50 V55" />
        <path d="M155 50 A7 8 0 0 1 169 50" />
        <path d="M158.5 50 A3.5 4 0 0 1 165.5 50" />
      </g>

      <path
        d="M213 33 L221 40 L213 47"
        className="stroke-ring"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      <path
        d="M240 21 L254 26 V39 C254 48 247 54 240 57 C233 54 226 48 226 39 V26 Z"
        fill="var(--success)"
      />
      <path
        d="M235 38.5 L239 42.5 L246 35"
        className="stroke-card"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
