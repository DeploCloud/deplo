import { cn } from "@/lib/utils";

/**
 * The Pull requests empty-state illustration, in two moods.
 *
 * `active` — a pull request drawing itself: a branch leaves the trunk, collects
 * two commits, and merges back. The shape every developer already reads as
 * "pull request", so it says what the page is for before the heading does. It
 * then fades and repeats, which is the point: an empty list is waiting for
 * something, and a still picture of a branch looks like a diagram, while one
 * that keeps drawing looks like a promise.
 *
 * `off` — the same branch, but it never gets there: it reaches out, stalls, and
 * retreats, dashed and muted, with no commits and no merge. Previews are
 * switched off for this app, and the drawing says exactly that — this could be
 * happening, and is not. Reusing the shape is deliberate: two drawings of the
 * same thing teach one idea, two unrelated ones teach none.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library: the whole
 * thing is stroke-dashoffset and a couple of scaled circles, so it costs one
 * paint and works in a server component. Colours come from tokens, so it is
 * correct in both themes without a second asset — and under
 * `prefers-reduced-motion` it holds its finished frame rather than vanishing.
 */
export function PullRequestGraphic({
  variant = "active",
  className,
}: {
  variant?: "active" | "off";
  className?: string;
}) {
  const off = variant === "off";
  return (
    <svg
      viewBox="0 0 120 100"
      fill="none"
      role="img"
      aria-label={
        off
          ? "A branch that starts and stops before it can merge"
          : "A branch merging back into the main branch"
      }
      className={cn("size-32", className)}
    >
      {/* The trunk: the branch pull requests are opened against. Deliberately
          recessive and always drawn — it is what exists before anybody opens
          anything, and the branch is the subject. Only the TOP gets a cap dot:
          one at the bottom would collide with the merge point. */}
      <line
        x1="30"
        y1="12"
        x2="30"
        y2="88"
        className="stroke-muted-foreground/40"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <circle cx="30" cy="12" r="3.5" className="fill-muted-foreground/40" />

      {/* The pull request: out of the trunk, along, and back in. One path so the
          draw-on reads as a single continuous gesture rather than three. */}
      <path
        d="M30 28 C30 40, 80 34, 80 46 L80 62 C80 74, 30 70, 30 82"
        className={
          off
            ? "deplo-pr-branch-off stroke-muted-foreground/50"
            : "deplo-pr-branch stroke-primary"
        }
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* Commits and the merge belong to a branch that actually lands. With
          previews off nothing arrives, so nothing is drawn — the outline of a
          commit that never happens would be noise, not information. */}
      {!off && (
        <>
          {/* Two commits, in the order they would arrive. Sixteen units apart so
              they stay two dots at every size — at 4.5 radius anything tighter
              fuses into one blob. */}
          <circle cx="80" cy="46" r="4.5" className="deplo-pr-commit-1 fill-primary" />
          <circle cx="80" cy="62" r="4.5" className="deplo-pr-commit-2 fill-primary" />

          {/* The merge point, the only thing that turns green: it is the moment
              the work lands, and the one beat worth colouring differently. */}
          <circle
            cx="30"
            cy="82"
            r="5"
            className="deplo-pr-merge"
            fill="var(--success)"
          />
        </>
      )}
    </svg>
  );
}
