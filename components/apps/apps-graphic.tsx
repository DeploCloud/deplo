import { cn } from "@/lib/utils";

/**
 * The Overview empty-state illustration: a rocket sitting on its pad, lifting
 * off, and coming back round for the next one.
 *
 * This is the first drawing a new instance shows, before a single app exists, so
 * it is the one place in the set that gets to be an invitation rather than a
 * diagram. It keeps the rocket the heading already used as an icon: the reader
 * loses nothing and gains the launch.
 *
 * `--chart-4` for the flame only - the amber reads as heat, and the machine
 * itself stays muted structure so the empty grid behind it never turns into a
 * poster. No `--success` here on purpose: green in this product means a
 * deployment went live, and nothing has been deployed yet.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. The rocket
 * rests on the pad for a third of the loop - it is the state the heading
 * describes, and a rocket permanently in flight would read as loading. Under
 * `prefers-reduced-motion` it holds that resting frame: on the pad, unlit.
 */
export function AppsGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A rocket lifting off from its launch pad"
      className={cn("size-32", className)}
    >
      {/* The pad: what is already there, waiting for something to launch. */}
      <line
        x1="34"
        y1="78"
        x2="86"
        y2="78"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* Exhaust rolling out sideways along the pad. Drawn before the rocket so
          it never covers it, and gone by the time the frame comes to rest. */}
      <g className="fill-border">
        <circle className="deplo-rocket-smoke" cx="42" cy="77" r="4" />
        <circle className="deplo-rocket-smoke" cx="78" cy="77" r="4" />
      </g>

      <g className="deplo-rocket">
        {/* Fins first: they tuck BEHIND the hull, which is what stops the two
            fills from meeting in a seam down the body's edge. */}
        <g
          className="fill-card stroke-muted-foreground"
          strokeWidth="2"
          strokeLinejoin="round"
        >
          <path d="M51 56 L44 74 L51 70 Z" />
          <path d="M69 56 L76 74 L69 70 Z" />
        </g>

        {/* The flame, under the hull for the same reason. It only burns while
            the rocket is climbing. */}
        <path
          className="deplo-rocket-flame"
          d="M54 64 Q60 92 66 64 Z"
          fill="var(--chart-4)"
        />

        {/* The hull. Filled, so neither the flame nor a fin shows through it. */}
        <path
          d="M60 34 C67 42 69 54 69 66 H51 C51 54 53 42 60 34 Z"
          className="fill-card stroke-muted-foreground"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <circle
          cx="60"
          cy="50"
          r="4.5"
          className="stroke-ring"
          strokeWidth="2"
        />
      </g>
    </svg>
  );
}
