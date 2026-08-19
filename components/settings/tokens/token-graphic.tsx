import { cn } from "@/lib/utils";

/**
 * The API tokens empty-state illustration: a key being cut, then turned in a
 * lock that springs open.
 *
 * A key is what the page already calls a token everywhere else - the list icon,
 * the "Create token" menu - so the drawing needs no new metaphor. What it adds
 * is the order: the bow and the shaft arrive first, then the teeth are cut, and
 * only then does the key open something. The teeth ARE the permissions, and the
 * shackle popping is what a token is FOR; the picture says both before the
 * heading does.
 *
 * Same grammar as `CronGraphic` and `NoResultsGraphic`: the lock is recessive
 * muted structure that is already there and never fades, the key is the subject
 * in colour, and there is exactly one beat where the work happens.
 *
 * Nothing stays. The key fades, the shackle closes and the loop starts over,
 * because no token exists yet - a frame that settled into an open lock would
 * draw the opposite of an empty state.
 *
 * `--chart-4` because a key is brass and because the other Settings drawings
 * are taken: Git and Git providers are violet, Registries is blue. The two
 * other amber drawings (Apps, Databases) live in Overview and Storage, so they
 * never share a screen with this one. Not `--warning`: a status colour on a
 * drawing with no status is a promise the page cannot keep.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. Every drawn
 * element carries `pathLength="1"`, so one keyframe drives both draws whatever
 * their real length. Under `prefers-reduced-motion` it holds the open lock.
 */
export function TokenGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="A key drawing itself, its teeth cut one after the other, then turning in a lock that opens"
      className={cn("size-32", className)}
    >
      {/* The shackle, first in the document so the body covers the two legs
          where they enter it. It pivots on the LEFT leg's base, which is what
          makes it swing out like a padlock instead of sliding up like a lid. */}
      <path
        className="deplo-token-shackle stroke-muted-foreground/40"
        d="M60 44V30a18 18 0 0 1 36 0v14"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The key, BEFORE the body: sliding under it is what sells "in the
          lock". Everything past the body's left edge is meant to be hidden. */}
      <g className="deplo-token-key">
        <g className="deplo-token-insert">
          <g stroke="var(--chart-4)" strokeWidth="5" strokeLinecap="round">
            {/* The bow, drawn first, and starting at its right-most point -
                which is exactly where the shaft picks up. Hollow, so it reads
                as the ring you hold and not as a blob on a stick. */}
            <circle
              className="deplo-token-draw"
              cx="15"
              cy="66"
              r="11"
              pathLength="1"
            />
            {/* The shaft, starting inside the bow so the joint is covered. Half
                a beat behind, which is what makes the two read as one stroke
                rather than as two things appearing at once. */}
            <line
              className="deplo-token-draw deplo-token-shaft"
              x1="24"
              y1="66"
              x2="48"
              y2="66"
              pathLength="1"
            />
          </g>

          {/* The teeth. They grow DOWN out of the shaft, one after the other,
              and they are the only elements that pop rather than draw - a cut
              is a stamp, not a stroke. Started at y=65 so the shaft's own
              5-unit stroke hides where they meet it, and far enough right that
              the insert takes both of them behind the lock. */}
          <g fill="var(--chart-4)">
            <rect
              className="deplo-token-tooth"
              x="35"
              y="65"
              width="5"
              height="11"
              rx="2"
            />
            <rect
              className="deplo-token-tooth"
              x="42"
              y="65"
              width="5"
              height="15"
              rx="2"
            />
          </g>
        </g>
      </g>

      {/* The body. Filled, and filled with the same token the empty state uses
          for its icon medallion, because an outline would let the inserted half
          of the key show through and turn the insert into an overlap. */}
      <rect
        x="50"
        y="42"
        width="56"
        height="48"
        rx="10"
        className="fill-secondary stroke-muted-foreground/40"
        strokeWidth="2.5"
      />

      {/* The keyhole, on top of the body, on the shaft's own line: it is what
          the angled key points at once it turns. */}
      <g className="fill-muted-foreground/40">
        <circle cx="78" cy="63" r="4.5" />
        <path d="M75.5 66h5l1.5 9h-8Z" />
      </g>
    </svg>
  );
}
