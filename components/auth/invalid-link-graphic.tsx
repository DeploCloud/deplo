import { cn } from "@/lib/utils";

/** The dead registration link: a chain that comes apart once and stays apart. */
export function InvalidLinkGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="A chain link that has come apart"
      className={cn("size-32", className)}
    >
      <g
        className="deplo-unlink-track stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="2 8"
      >
        <line x1="10" y1="110" x2="28" y2="92" />
        <line x1="92" y1="28" x2="110" y2="10" />
      </g>

      <g
        transform="translate(12 12) scale(4)"
        strokeWidth="0.625"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          className="deplo-unlink-a stroke-muted-foreground"
          d="M18.84 12.25l1.72-1.71h-.02a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"
        />
        <path
          className="deplo-unlink-b stroke-muted-foreground"
          d="M5.17 11.75l-1.71 1.71a5.004 5.004 0 0 0 .12 7.07 5.006 5.006 0 0 0 6.95 0l1.71-1.71"
        />
        <g className="deplo-unlink-spark stroke-ring">
          <path d="M8 2v3" />
          <path d="M2 8h3" />
          <path d="M16 22v-3" />
          <path d="M22 16h-3" />
        </g>
      </g>
    </svg>
  );
}
