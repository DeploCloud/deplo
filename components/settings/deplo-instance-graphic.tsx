import { LOGO_PATH, MARK_VIEWBOX } from "@/components/logo";
import { cn } from "@/lib/utils";

/** The Deplo card's mark: the panel, the network it owns, and the hosts on it. */
export function DeploInstanceGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 272 80"
      fill="none"
      role="img"
      aria-label="The Deplo panel, the network it owns, and the servers it runs on"
      className={cn("h-full w-full", className)}
    >
      {/* The panel itself. */}
      <rect
        x="6"
        y="14"
        width="90"
        height="52"
        rx="12"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />
      <g className="fill-border">
        <circle cx="19" cy="25" r="2.5" />
        <circle cx="28" cy="25" r="2.5" />
      </g>
      <circle cx="83" cy="25" r="3" fill="var(--success)" />
      <svg
        x="41"
        y="29"
        width="22"
        height="22"
        viewBox={MARK_VIEWBOX}
        className="text-muted-foreground"
      >
        <path d={LOGO_PATH} fill="currentColor" />
      </svg>

      {/* The shared network, fanning out to every host. */}
      <g
        className="stroke-border"
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M100 40 L190 22" />
        <path d="M100 40 H190" />
        <path d="M100 40 L190 58" />
      </g>

      {/* The hosts. */}
      {[14, 32, 50].map((y) => (
        <g key={y}>
          <rect
            x="192"
            y={y}
            width="74"
            height="16"
            rx="5"
            className="fill-secondary stroke-ring"
            strokeWidth="2.5"
          />
          <g className="fill-border">
            <rect x="201" y={y + 6} width="26" height="4" rx="2" />
            <rect x="233" y={y + 6} width="14" height="4" rx="2" />
          </g>
          <circle cx="256" cy={y + 8} r="2.5" className="fill-ring" />
        </g>
      ))}
    </svg>
  );
}
