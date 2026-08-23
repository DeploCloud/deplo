import { cn } from "@/lib/utils";

/**
 * The Logs empty-state illustration: an empty pane with a blinking caret, into
 * which log lines arrive one after another before the buffer clears and waits
 * again.
 *
 * The page is empty because nothing has written yet, so the drawing is the
 * promise of what will fill it - the same move the cron dial and the deploy
 * conveyor make. A still terminal glyph would only repeat the heading.
 *
 * Grey throughout, and deliberately: a log line has no status of its own here,
 * and the coloured beat the other drawings get (`--success` for a merge, a fired
 * job, a live server) would claim one. The pane is `--ring`, its window buttons
 * `--border`, and the lines themselves `--muted-foreground` - three solid greys,
 * never one grey faded down.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library, so it costs
 * one paint and renders in a server component. Under `prefers-reduced-motion` it
 * holds the filled frame: three lines written, caret steady.
 */
export function LogsGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="An empty log pane filling with lines of output, one after another"
      className={cn("size-32", className)}
    >
      {/* The pane: already there before anything is logged, so it never moves. */}
      <rect
        x="10"
        y="14"
        width="100"
        height="62"
        rx="5"
        className="stroke-ring"
        strokeWidth="2"
      />
      <line
        x1="10"
        y1="28"
        x2="110"
        y2="28"
        className="stroke-ring"
        strokeWidth="2"
      />

      {/* Window buttons. Three dots are the whole difference between a rounded
          rectangle and a terminal. */}
      <g className="fill-border">
        <circle cx="18" cy="21" r="2" />
        <circle cx="25" cy="21" r="2" />
        <circle cx="32" cy="21" r="2" />
      </g>

      {/* The output. Staggered by `nth-child`, so document order is the order
          they are written - which is what makes three lines read as one stream
          rather than three things blinking. Widths differ because real log
          lines do; identical bars read as a placeholder skeleton. */}
      <g
        className="stroke-muted-foreground"
        strokeWidth="3"
        strokeLinecap="round"
      >
        <line className="deplo-logs-line" x1="20" y1="38" x2="76" y2="38" />
        <line className="deplo-logs-line" x1="20" y1="48" x2="94" y2="48" />
        <line className="deplo-logs-line" x1="20" y1="58" x2="62" y2="58" />
      </g>

      {/* The caret: the one thing that is there while the pane is empty, and the
          reason the frame never looks broken during the rest beat. It starts on
          the first row and drops a row as each line lands - a caret parked at the
          bottom of an empty pane is the tell that nothing was really written. */}
      <line
        className="deplo-logs-caret stroke-muted-foreground"
        x1="20"
        y1="34"
        x2="20"
        y2="42"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
