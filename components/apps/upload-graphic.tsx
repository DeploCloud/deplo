import { cn } from "@/lib/utils";

/**
 * The picture on the archive drop area: a zipped archive above an open tray.
 * It moves when the drop zone is hovered OR has a file over it, so the same
 * gesture answers both - the archive dips and the tray opens to take it.
 */
export function UploadGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="An archive dropping into an open tray"
      className={cn("size-28", className)}
    >
      {/* The tray: furniture, and its two flaps open outwards on hover. */}
      <g className="stroke-border" strokeWidth="3" strokeLinecap="round">
        <path d="M22 82v14a8 8 0 0 0 8 8h60a8 8 0 0 0 8-8V82" />
        {/* Translated, not rotated: a CSS rotate on an SVG child depends on
            transform-box, which is not worth pinning for two flaps. */}
        <path
          d="M22 82 38 72"
          className="transition-transform duration-300 ease-out group-hover:-translate-x-[3px] group-hover:-translate-y-[3px] group-data-[active]:-translate-x-[3px] group-data-[active]:-translate-y-[3px] motion-reduce:transition-none"
        />
        <path
          d="M98 82 82 72"
          className="transition-transform duration-300 ease-out group-hover:translate-x-[3px] group-hover:-translate-y-[3px] group-data-[active]:translate-x-[3px] group-data-[active]:-translate-y-[3px] motion-reduce:transition-none"
        />
      </g>

      {/* The archive is the subject, and the piece that travels. */}
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
        {/* The zip: what makes it an archive rather than a document. */}
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

      {/* The hint that it goes DOWN, in on its own so it can lag behind the
          archive by a beat. */}
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
