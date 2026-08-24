import { cn } from "@/lib/utils";

/**
 * The environment variables empty-state illustration: a variable being written
 * into an empty list, its value scrambled, and the padlock clicking shut over
 * what is left.
 *
 * `KEY = ****` is the shape everyone already reads as "environment variable", so
 * the drawing says what belongs here before the heading does. The three beats
 * after it are the promise of the page: the value arrives as characters you could
 * read, it is churned, and what settles is a masked row behind a closed lock.
 * That is literally what happens - the value is encrypted with a key derived from
 * `DEPLO_SECRET` before it is ever stored, and from then on nothing can read it
 * back out.
 *
 * The plaintext beat is short and one-way ON PURPOSE. A drawing that showed a
 * readable STORED value would promise a reveal that does not exist; showing the
 * value only on the way in, and never again after the lock closes, says the
 * opposite - this door swings one way.
 *
 * Same grammar as the Pull requests and Cron jobs drawings - recessive muted
 * structure, one accent for the subject - but a DIFFERENT accent on purpose.
 * Those two spend `--primary` and `--success`; this one is `--info`, so three
 * empty states in the same product do not all read as the same picture. The lock
 * body and the masked dots share the value's dimmer `0.7`, so they read as the
 * same hidden thing; the shackle is full strength because it is what moves.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. The scramble
 * is `scaleY` on hard `steps()` cuts, which is what separates it from a smooth
 * pulse - characters CHANGE, they do not breathe. Colours are tokens, so both
 * themes are right without a second asset, and under `prefers-reduced-motion` it
 * holds the finished frame: masked value, lock closed.
 */
export function EnvGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A variable being written into a list, its value scrambled and locked away masked"
      className={cn("size-32", className)}
    >
      {/* The list itself: what is already there, waiting. Recessive and never
          animated, so the eye goes to the row being written. */}
      <rect
        x="10"
        y="17"
        width="100"
        height="56"
        rx="10"
        className="stroke-ring"
        strokeWidth="2.5"
      />

      {/* The equals. Muted because it is grammar, not content - it is the same
          on every row that will ever land here. */}
      <g className="stroke-border" strokeWidth="2" strokeLinecap="round">
        <line x1="48" y1="41" x2="55" y2="41" />
        <line x1="48" y1="49" x2="55" y2="49" />
      </g>

      {/* The name, drawing itself left to right the way it is typed. */}
      <line
        x1="20"
        y1="45"
        x2="40"
        y2="45"
        className="deplo-env-key"
        stroke="var(--info)"
        strokeWidth="6"
        strokeLinecap="round"
      />

      {/* The value as it arrives: four characters of different heights, which is
          what makes them read as text rather than as a row of identical blobs.
          They then churn on hard cuts and collapse as the mask takes over. */}
      <g stroke="var(--info)" strokeWidth="4.5" strokeLinecap="round">
        <line className="deplo-env-plain" x1="62" y1="41.5" x2="62" y2="48.5" />
        <line className="deplo-env-plain" x1="71" y1="43" x2="71" y2="47" />
        <line className="deplo-env-plain" x1="80" y1="40.5" x2="80" y2="49.5" />
        <line className="deplo-env-plain" x1="89" y1="42.5" x2="89" y2="47.5" />
      </g>

      {/* What is left once it is encrypted: four identical dots, all landing on
          the same beat as the lock. Nine apart at r=3, so the three units between
          them keep them reading as characters instead of fusing into one bar.
          `fill-opacity` sits under the animated `opacity`, so the two multiply
          and the mask stays a shade behind the name it belongs to. */}
      <g fill="var(--info)" fillOpacity="0.7">
        <circle cx="62" cy="45" r="3" className="deplo-env-dot" />
        <circle cx="71" cy="45" r="3" className="deplo-env-dot" />
        <circle cx="80" cy="45" r="3" className="deplo-env-dot" />
        <circle cx="89" cy="45" r="3" className="deplo-env-dot" />
      </g>

      {/* The padlock. It appears open, with the value still readable, and snaps
          shut on the beat the mask lands - the two halves of one idea. The group
          carries the pop; the shackle turns inside it, because one `transform`
          cannot hold both. */}
      <g className="deplo-env-lock">
        <rect
          x="95.5"
          y="43.5"
          width="9"
          height="9"
          rx="2"
          fill="var(--info)"
          fillOpacity="0.7"
        />
        {/* Hinged on its left leg, which is why the whole 5-unit arc lifts clear
            of the body when it is open instead of swinging down into it. */}
        <path
          d="M97.5 43.5 V40 A2.5 2.5 0 0 1 102.5 40 V43.5"
          className="deplo-env-shackle"
          stroke="var(--info)"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
