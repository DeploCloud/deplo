import { cn } from "@/lib/utils";

/** The "you need an app" mark: a phone showing a code and the ring counting it down. */
export function AuthenticatorAppGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 44 64"
      fill="none"
      role="img"
      aria-label="A phone showing a six-digit code and its countdown"
      className={cn("size-12", className)}
    >
      <rect
        x="4"
        y="2"
        width="36"
        height="60"
        rx="7"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />

      <g className="stroke-border" strokeWidth="2" strokeLinecap="round">
        <line x1="18" y1="8" x2="26" y2="8" />
        <line x1="18" y1="56" x2="26" y2="56" />
      </g>

      {/* The 30-second window: a full track, and the slice still left on it. */}
      <circle cx="22" cy="26" r="7" className="stroke-ring" strokeWidth="2.5" />
      <path
        d="M22 19 A7 7 0 1 1 15 26"
        stroke="var(--chart-1)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <g className="fill-muted-foreground">
        <rect x="8" y="41" width="3" height="9" rx="1.5" />
        <rect x="13" y="41" width="3" height="9" rx="1.5" />
        <rect x="18" y="41" width="3" height="9" rx="1.5" />
        <rect x="23" y="41" width="3" height="9" rx="1.5" />
        <rect x="28" y="41" width="3" height="9" rx="1.5" />
        <rect x="33" y="41" width="3" height="9" rx="1.5" />
      </g>
    </svg>
  );
}
