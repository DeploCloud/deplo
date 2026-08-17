import { cn } from "@/lib/utils";

/**
 * The API tokens empty-state illustration: a key being cut, teeth last.
 *
 * A key is what the page already calls a token everywhere else - the list icon,
 * the "Create token" menu - so the drawing needs no new metaphor. What it adds
 * is the order: the bow and the shaft arrive first, and only then are the teeth
 * cut. The teeth ARE the permissions, which is the one thing to decide before
 * minting a token, and the picture says it before the heading does.
 *
 * Nothing stays. The key fades and the loop starts over, because no token
 * exists yet - a frame that settled into a finished key would draw the opposite
 * of an empty state.
 *
 * `--chart-4` because a key is brass and because the other Settings drawings
 * are taken: Git and Git providers are violet, Registries is blue. The two
 * other amber drawings (Apps, Databases) live in Overview and Storage, so they
 * never share a screen with this one. Not `--warning`: a status colour on a
 * drawing with no status is a promise the page cannot keep.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. Every drawn
 * element carries `pathLength="1"`, so one keyframe drives both draws whatever
 * their real length. Under `prefers-reduced-motion` it holds the cut key.
 */
export function TokenGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A key drawing itself, its teeth cut one after the other"
      className={cn("size-32", className)}
    >
      {/* One group for the whole key, because the fade belongs to the key and
          not to its parts: each half enters on its own delay, so per-element
          fades would take them away in the same staggered order and the key
          would dissolve in pieces.

          `pathLength="1"` goes on each shape, never on the group - it does not
          inherit, and without it the shared `stroke-dasharray: 1` would draw a
          one-unit dotted line instead of one dash the length of the path. */}
      <g className="deplo-token-key">
        <g stroke="var(--chart-4)" strokeWidth="5" strokeLinecap="round">
          {/* The bow, drawn first, and starting at its right-most point - which
              is exactly where the shaft picks up. Hollow, so it reads as the
              ring you hold and not as a blob on a stick. */}
          <circle
            className="deplo-token-draw"
            cx="32"
            cy="45"
            r="13"
            pathLength="1"
          />
          {/* The shaft, starting inside the bow so the joint is covered. Half a
              beat behind, which is what makes the two read as one stroke rather
              than as two things appearing at once. */}
          <line
            className="deplo-token-draw deplo-token-shaft"
            x1="42"
            y1="45"
            x2="98"
            y2="45"
            pathLength="1"
          />
        </g>

        {/* The teeth. They grow DOWN out of the shaft, one after the other, and
            they are the only elements that pop rather than draw - a cut is a
            stamp, not a stroke. Started at y=44 so the shaft's own 5-unit
            stroke hides where they meet it. */}
        <g fill="var(--chart-4)">
          <rect
            className="deplo-token-tooth"
            x="78"
            y="44"
            width="5"
            height="12"
            rx="2"
          />
          <rect
            className="deplo-token-tooth"
            x="89"
            y="44"
            width="5"
            height="17"
            rx="2"
          />
        </g>
      </g>
    </svg>
  );
}
