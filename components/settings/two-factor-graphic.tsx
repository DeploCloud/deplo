import { cn } from "@/lib/utils";

/** The Security card's mark: a phone holding a one-time code, signed off by a shield. */
export function TwoFactorGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 96 96"
      fill="none"
      role="img"
      aria-label="A phone showing a one-time code, with a shield and a tick beside it"
      className={cn("size-24", className)}
    >
      <rect
        x="22"
        y="8"
        width="42"
        height="74"
        rx="9"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />
      <rect
        x="37"
        y="15"
        width="12"
        height="3"
        rx="1.5"
        className="fill-border"
      />

      <g fill="var(--chart-1)">
        <rect x="30" y="36" width="7" height="12" rx="2" />
        <rect x="39.5" y="36" width="7" height="12" rx="2" />
        <rect x="49" y="36" width="7" height="12" rx="2" />
      </g>
      <rect
        x="30"
        y="56"
        width="26"
        height="4"
        rx="2"
        className="fill-border"
      />
      <rect
        x="30"
        y="64"
        width="16"
        height="4"
        rx="2"
        className="fill-border"
      />

      <g paintOrder="stroke" className="stroke-card" strokeWidth="5">
        <path
          d="M72 44 L86 49 V62 C86 71 79 77 72 80 C65 77 58 71 58 62 V49 Z"
          fill="var(--success)"
        />
      </g>
      <path
        d="M67 61.5 L71 65.5 L78 58"
        className="stroke-card"
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
