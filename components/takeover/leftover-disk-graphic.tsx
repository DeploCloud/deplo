import { cn } from "@/lib/utils";

/** The old panel: stopped, and still taking its share of the machine's disk. */
export function LeftoverDiskGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 130"
      fill="none"
      role="img"
      aria-label="A disk with the stopped platform still taking up part of it"
      className={cn("h-auto w-full", className)}
    >
      <path
        d="M28 116 H212"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <rect
        x="40"
        y="34"
        width="160"
        height="72"
        rx="12"
        className="fill-secondary stroke-ring"
        strokeWidth="2.5"
      />

      <g className="deplo-disk-tile">
        <rect
          x="56"
          y="48"
          width="28"
          height="28"
          rx="8"
          className="fill-card stroke-ring"
          strokeWidth="2.5"
        />
        <g fill="var(--warning)">
          <rect x="64" y="56" width="4" height="12" rx="2" />
          <rect x="72" y="56" width="4" height="12" rx="2" />
        </g>
        <g className="fill-border">
          <rect x="96" y="53" width="52" height="7" rx="3.5" />
          <rect x="96" y="66" width="76" height="7" rx="3.5" />
        </g>
      </g>

      <rect
        x="56"
        y="86"
        width="128"
        height="9"
        rx="4.5"
        className="fill-border"
      />
      <rect
        x="56"
        y="86"
        width="80"
        height="9"
        rx="4.5"
        fill="var(--warning)"
        className="deplo-disk-fill"
      />
    </svg>
  );
}
