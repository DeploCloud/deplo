import { cn } from "@/lib/utils";

/**
 * The Cron jobs empty-state illustration: a dial with a hand sweeping round it,
 * firing the job every time it crosses the top mark.
 *
 * A still clock says "time"; a clock that keeps coming back round says
 * "schedule", which is the only thing this page is about. The list is empty and
 * waiting for something, so the drawing is a promise of what will fill it,
 * exactly like the Pull requests empty state drawing a branch that merges
 * instead of showing a git glyph.
 *
 * Same visual grammar as `PullRequestGraphic` on purpose: recessive muted
 * structure, the subject in primary, and one success-coloured dot for the moment
 * the work actually happens. Two illustrations that share a vocabulary teach one
 * idea; two unrelated ones teach none.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library, so it costs
 * one paint and renders in a server component. Colours come from tokens, so it
 * is correct in both themes without a second asset, and under
 * `prefers-reduced-motion` it holds the fired frame rather than freezing on an
 * empty dial.
 */
export function CronGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="A clock hand sweeping round a dial, firing a job each time it passes the top mark"
      className={cn("size-32", className)}
    >
      {/* The dial: what is already there before anything is scheduled. Recessive
          and never animated, so the eye goes to the hand. */}
      <circle
        cx="60"
        cy="60"
        r="42"
        className="stroke-muted-foreground/40"
        strokeWidth="2.5"
      />

      {/* Three ticks, at 3, 6 and 9. The fourth position is the fire mark itself
          and a tick under it would blunt the one beat that matters. They stop at
          r=40 so they meet the ring's inner edge instead of crossing it. */}
      <g className="stroke-muted-foreground/30" strokeWidth="2" strokeLinecap="round">
        <line x1="93" y1="60" x2="100" y2="60" />
        <line x1="60" y1="93" x2="60" y2="100" />
        <line x1="27" y1="60" x2="20" y2="60" />
      </g>

      {/* The pulse the run throws off, drawn before the hand so a fading ring
          never sits on top of it. The ring scales 2.6x, and a scaled stroke
          would thicken with it into a blob, hence `non-scaling-stroke`: held at
          2px it stays a ripple all the way out. */}
      <circle
        cx="60"
        cy="18"
        r="5"
        className="deplo-cron-pulse"
        stroke="var(--success)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />

      {/* The hand: the subject, and the only thing that moves for real. It stops
          short of the mark so the two never overlap at the top of the loop. */}
      <line
        x1="60"
        y1="60"
        x2="60"
        y2="32"
        className="deplo-cron-hand stroke-primary"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="60" cy="60" r="3" className="fill-primary" />

      {/* The run: the top mark lights up as the hand crosses it. Green because
          it is the moment the command actually executes, the same beat the merge
          dot gets on the Pull requests drawing. */}
      <circle
        cx="60"
        cy="18"
        r="5"
        className="deplo-cron-fire"
        fill="var(--success)"
      />
    </svg>
  );
}
