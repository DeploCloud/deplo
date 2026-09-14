import { cn } from "@/lib/utils";

// UploadGraphic - the archive drop area's picture, animated on hover and on drag-over alike.
export function UploadGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="An archive dropping into an open tray"
      className={cn("size-28", className)}
    >
      <g className="stroke-border" strokeWidth="3" strokeLinecap="round">
        <path d="M22 82v14a8 8 0 0 0 8 8h60a8 8 0 0 0 8-8V82" />
        {/* Translated, not rotated: a CSS rotate on an SVG child depends on transform-box. */}
        <path
          d="M22 82 38 72"
          className="transition-transform duration-300 ease-out group-hover:-translate-x-[3px] group-hover:-translate-y-[3px] group-data-[active]:-translate-x-[3px] group-data-[active]:-translate-y-[3px] motion-reduce:transition-none"
        />
        <path
          d="M98 82 82 72"
          className="transition-transform duration-300 ease-out group-hover:translate-x-[3px] group-hover:-translate-y-[3px] group-data-[active]:translate-x-[3px] group-data-[active]:-translate-y-[3px] motion-reduce:transition-none"
        />
      </g>

      <g className="transition-transform duration-300 ease-out group-hover:translate-y-[7px] group-data-[active]:translate-y-[7px] motion-reduce:transition-none">
        <rect
          x="41"
          y="16"
          width="38"
          height="50"
          rx="7"
          className="fill-background stroke-muted-foreground"
          strokeWidth="3"
        />
        <g className="stroke-ring" strokeWidth="3" strokeLinecap="round">
          <path d="M60 16v8" />
          <path d="M60 30v7" />
          <path d="M60 43v7" />
        </g>
        <rect
          x="54"
          y="52"
          width="12"
          height="9"
          rx="2.5"
          className="stroke-ring"
          strokeWidth="2.5"
        />
      </g>

      <path
        d="M52 74 60 82 68 74"
        className="stroke-muted-foreground opacity-0 transition-all duration-300 ease-out group-hover:translate-y-1 group-hover:opacity-100 group-data-[active]:translate-y-1 group-data-[active]:opacity-100 motion-reduce:transition-none"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
