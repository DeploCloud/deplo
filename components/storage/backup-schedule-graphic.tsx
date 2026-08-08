import { cn } from "@/lib/utils";

/**
 * The scheduled backups empty-state illustration: a loop closing around an
 * archive, over and over.
 *
 * A schedule is not a moment, it is a RETURN, so the drawing returns: the arrow
 * sweeps the whole way round the archive, lands its head, holds, and starts the
 * lap again. That is the only idea on this page - a backup that happens without
 * anyone remembering to take it.
 *
 * Deliberately not the Cron jobs dial, which is a clock face with a hand and a
 * fire mark. The two do share a subject, and a family resemblance between two
 * schedules is right; drawing them the same way would not be.
 *
 * `--chart-1`. The three tabs of this page have to differ at a glance:
 * Databases is `--chart-4`, destinations is `--chart-5`, this one is blue.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. The arc is
 * one `stroke-dashoffset` and the head is one pop on a delay - the same two
 * gestures the Pull requests drawing uses. Under `prefers-reduced-motion` it
 * holds the closed loop.
 */
export function BackupScheduleGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="An arrow looping round an archive, closing and starting again"
      className={cn("size-32", className)}
    >
      {/* What gets copied. Recessive: the loop is the subject, this is only what
          it goes around. */}
      <g
        className="stroke-muted-foreground/40"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="46" y="34" width="28" height="22" rx="3" />
        <path d="M46 42 L74 42" />
        <path d="M56 49 L64 49" />
      </g>

      {/* The lap: 300 degrees of a radius-30 circle, so the gap is where the head
          lands rather than an arbitrary break. Length is 2 * pi * 30 * 300/360 =
          157.1, which is the dasharray that draws it on. */}
      <path
        d="M60 15 A30 30 0 1 1 34.02 30"
        className="deplo-bk-loop"
        stroke="var(--chart-1)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The head, on the tangent at the arc's end and popping in only once the
          arc has arrived - the lap closing is the beat worth marking. */}
      <path
        d="M34.02 37 L34.02 30 L27.96 33.5"
        className="deplo-bk-arrow"
        stroke="var(--chart-1)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
