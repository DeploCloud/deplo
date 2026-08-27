import { LOGO_PATH, MARK_VIEWBOX } from "@/components/logo";
import { cn } from "@/lib/utils";

/** The Updates mark: the releases behind this one, and the one it is running. */
export function UpdateGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 220"
      fill="none"
      role="img"
      aria-label="A timeline of Deplo releases, with the one this instance runs marked"
      className={cn("h-auto w-full", className)}
    >
      {/* The line the releases hang off. */}
      <path
        d="M30 22 V198"
        className="stroke-border"
        strokeWidth="2"
        strokeLinecap="round"
      />

      {/* Newest, still ahead of this instance. */}
      <circle cx="30" cy="39" r="6" fill="var(--success)" />
      <Release y="16" accent />
      {/* The ones in between. */}
      <circle cx="30" cy="101" r="5" className="fill-ring" />
      <Release y="78" />
      {/* The one running here. */}
      <circle cx="30" cy="163" r="5" className="fill-ring" />
      <rect
        x="48"
        y="140"
        width="176"
        height="46"
        rx="10"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />
      <svg
        x="62"
        y="152"
        width="22"
        height="22"
        viewBox={MARK_VIEWBOX}
        className="text-muted-foreground"
      >
        <path d={LOGO_PATH} fill="currentColor" />
      </svg>
      <g className="fill-border">
        <rect x="94" y="156" width="62" height="6" rx="3" />
        <rect x="94" y="168" width="98" height="6" rx="3" />
      </g>
    </svg>
  );
}

/** One published release: a tag and two lines of notes. */
function Release({ y, accent }: { y: string; accent?: boolean }) {
  const top = Number(y);
  return (
    <>
      <rect
        x="48"
        y={y}
        width="176"
        height="46"
        rx="10"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />
      <rect
        x="62"
        y={top + 14}
        width="34"
        height="10"
        rx="5"
        fill={accent ? "var(--success)" : undefined}
        className={accent ? undefined : "fill-border"}
      />
      <g className="fill-border">
        <rect x="106" y={top + 16} width="72" height="6" rx="3" />
        <rect x="62" y={top + 32} width="116" height="6" rx="3" />
      </g>
    </>
  );
}
