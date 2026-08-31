import { cn } from "@/lib/utils";

export type SecurityLevel = "weak" | "good" | "strong";

/** How many of the three plates are lit, and in which colour. */
const LIT: Record<SecurityLevel, number> = { weak: 1, good: 2, strong: 3 };

/**
 * The Security page's mark: three plates of a shield, one per factor the account
 * actually carries.
 */
export function SecurityGraphic({
  level,
  className,
}: {
  level: SecurityLevel;
  className?: string;
}) {
  const lit = LIT[level];
  const tone = level === "strong" ? "var(--success)" : "var(--chart-1)";
  const plate = (i: number) => (lit > i ? tone : "var(--secondary)");
  const edge = (i: number) => (lit > i ? tone : "var(--ring)");

  return (
    <svg
      viewBox="0 0 272 80"
      fill="none"
      role="img"
      aria-label={`A shield of three plates, ${lit} of them closed`}
      className={cn("h-full w-full", className)}
    >
      <g className="fill-border">
        <rect x="16" y="66" width="240" height="4" rx="2" />
        <rect x="34" y="14" width="4" height="56" rx="2" />
        <rect x="234" y="14" width="4" height="56" rx="2" />
      </g>

      {/* Left: the password, always there - it is what an account is made of. */}
      <rect
        x="54"
        y="24"
        width="60"
        height="34"
        rx="10"
        fill={plate(0)}
        stroke={edge(0)}
        strokeWidth="2.5"
      />
      <g fill={lit > 0 ? "var(--card)" : "var(--muted-foreground)"}>
        <circle cx="72" cy="41" r="3.5" />
        <circle cx="84" cy="41" r="3.5" />
        <circle cx="96" cy="41" r="3.5" />
      </g>

      {/* Middle: the second factor - a phone showing a code. */}
      <rect
        x="126"
        y="14"
        width="34"
        height="54"
        rx="8"
        fill={plate(1)}
        stroke={edge(1)}
        strokeWidth="2.5"
      />
      <g fill={lit > 1 ? "var(--card)" : "var(--muted-foreground)"}>
        <rect x="133" y="28" width="5" height="11" rx="2" />
        <rect x="140.5" y="28" width="5" height="11" rx="2" />
        <rect x="148" y="28" width="5" height="11" rx="2" />
        <rect x="133" y="46" width="20" height="4" rx="2" />
      </g>

      {/* Right: the passkey, the plate most accounts are missing. */}
      <path
        d="M178 20 h40 a6 6 0 0 1 6 6 v16 c0 12-11 18-26 22-15-4-26-10-26-22 V26 a6 6 0 0 1 6-6 z"
        fill={plate(2)}
        stroke={edge(2)}
        strokeWidth="2.5"
      />
      <g
        stroke={lit > 2 ? "var(--card)" : "var(--muted-foreground)"}
        strokeWidth="2.5"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M191 48 a7 7 0 0 1 14 0" />
        <path d="M195.5 48 a2.5 2.5 0 0 1 5 0" />
        <path d="M186.5 48 a11.5 11.5 0 0 1 23 0" />
      </g>
    </svg>
  );
}
