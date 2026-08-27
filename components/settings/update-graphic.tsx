import { LOGO_PATH, MARK_VIEWBOX } from "@/components/logo";
import { cn } from "@/lib/utils";

/** What the drawing is saying: still asking, up to date, a release waiting, or out of reach. */
export type UpdateMood = "checking" | "current" | "available" | "unknown";

/** The Updates mark: a release leaving the repository for this panel. */
export function UpdateGraphic({
  mood,
  className,
}: {
  mood: UpdateMood;
  className?: string;
}) {
  const label =
    mood === "available"
      ? "A new release travelling from the repository into this panel"
      : mood === "unknown"
        ? "A release stopped by a break in the line to the repository"
        : mood === "checking"
          ? "This panel asking the repository for the newest release"
          : "This panel holding the newest release";

  return (
    <svg
      viewBox="0 0 272 80"
      fill="none"
      role="img"
      aria-label={label}
      className={cn("h-full w-full", className)}
    >
      {/* The repository the releases come from. */}
      <rect
        x="6"
        y="20"
        width="60"
        height="40"
        rx="10"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />
      <g className="fill-border">
        <rect x="16" y="31" width="30" height="4" rx="2" />
        <rect x="16" y="45" width="20" height="4" rx="2" />
      </g>

      {/* The line between them, broken when the check could not be made. */}
      <g
        className="stroke-border"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      >
        {mood === "unknown" ? (
          <>
            <path d="M70 40 H124" />
            <path d="M148 40 H172" />
          </>
        ) : (
          <path d="M70 40 H172" />
        )}
      </g>
      {mood === "unknown" && (
        <g
          stroke="var(--warning)"
          strokeWidth="2.5"
          strokeLinecap="round"
          fill="none"
        >
          <path d="M130 32 L142 48" />
          <path d="M142 32 L130 48" />
        </g>
      )}

      {/* The release on the move. */}
      {mood !== "current" && (
        <g
          className={
            mood === "unknown" ? "deplo-upd-stall" : "deplo-upd-packet"
          }
        >
          <rect
            x="66"
            y="31"
            width="28"
            height="18"
            rx="6"
            className="fill-card"
            stroke="var(--success)"
            strokeWidth="2.5"
          />
          <path
            d="M80 45 V35 M75.5 39.5 L80 35 L84.5 39.5"
            stroke="var(--success)"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}

      {/* This panel. */}
      <rect
        x="176"
        y="14"
        width="90"
        height="52"
        rx="12"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />
      <g className="fill-border">
        <circle cx="189" cy="25" r="2.5" />
        <circle cx="198" cy="25" r="2.5" />
      </g>
      <svg
        x="210"
        y="30"
        width="22"
        height="22"
        viewBox={MARK_VIEWBOX}
        className="text-muted-foreground"
      >
        <path d={LOGO_PATH} fill="currentColor" />
      </svg>

      {mood === "available" && (
        <circle
          cx="221"
          cy="41"
          r="19"
          className="deplo-upd-ring"
          fill="none"
          stroke="var(--success)"
          strokeWidth="2.5"
        />
      )}
      {mood === "current" && (
        <g className="deplo-upd-badge">
          <circle cx="252" cy="25" r="9" fill="var(--success)" />
          <path
            d="M247.5 25.5 L250.5 28.5 L256.5 21.5"
            className="stroke-card"
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      )}
    </svg>
  );
}
