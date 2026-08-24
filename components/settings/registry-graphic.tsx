import { cn } from "@/lib/utils";

/**
 * The Registries empty-state illustration: a whale afloat with its containers,
 * breathing.
 *
 * The page is about container images and where they are kept, and there is
 * exactly one drawing the world already reads as "container images". Inventing a
 * different metaphor for the one concept that has a universally known picture
 * would be a fresh word for a thing everybody can already name.
 *
 * It IDLES rather than acts, and that is the honest frame for this empty state:
 * nothing is being pulled, because no registry is connected yet. The images are
 * out there, floating, waiting to be reached. The Databases drawing makes the
 * same argument with a tumbleweed - a frame that never stops working reads as
 * loading, not as empty.
 *
 * Every other motion in the set was already spoken for, which is why this one
 * only bobs: a vertical drop is Backup artifacts building a stack, horizontal
 * travel is Deployments and Git, rotation is Domains, a sway is "app is not
 * running". Bobbing in place, plus one puff from the blowhole, is the only beat
 * left - and it happens to be exactly what a thing floating at rest does.
 *
 * `--chart-1` because Docker's own colour is blue and this is unmistakably its
 * whale; the only other blue in the set (Backup schedules) lives in Storage, a
 * different section entirely, so the two never share a screen. Not `--success`
 * or `--warning`: a status colour on a drawing with no status is a promise the
 * page cannot keep.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. Under
 * `prefers-reduced-motion` it holds the resting frame: whale level, no puff.
 */
export function RegistryGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A whale floating with a stack of containers on its back"
      className={cn("size-32", className)}
    >
      {/* The sea. Two short strokes rather than one long line: a single rule
          under the whale reads as a shelf (which is Backup artifacts), while two
          offset ones read as water. Static - the whale moves, the sea does not,
          so there is one moving idea and not two competing ones. */}
      <g className="stroke-border" strokeWidth="2.5" strokeLinecap="round">
        <line x1="20" y1="74" x2="58" y2="74" />
        <line x1="66" y1="74" x2="100" y2="74" />
        <line x1="34" y1="82" x2="62" y2="82" />
        <line x1="70" y1="82" x2="88" y2="82" />
      </g>

      {/* Everything that floats, in one group, so the bob moves the cargo with
          the hull instead of sliding it around on deck. */}
      <g className="deplo-registry-whale">
        {/* The puff. Authored at the blowhole and animated upward; two of them,
            staggered, so the whale reads as breathing rather than as having
            hiccuped once. */}
        <g fill="var(--chart-1)">
          <circle
            className="deplo-registry-puff"
            cx="86"
            cy="38"
            r="3"
            opacity="0"
          />
          <circle
            className="deplo-registry-puff"
            cx="86"
            cy="38"
            r="2"
            opacity="0"
          />
        </g>

        {/* Tail, then hull. The tail is drawn first so the hull's rounded end
            covers the joint. */}
        <path d="M32 53 L16 43 L16 63 Z" fill="var(--chart-1)" />
        <rect
          x="30"
          y="42"
          width="62"
          height="22"
          rx="11"
          fill="var(--chart-1)"
        />
        {/* The eye, punched out in the card colour so it reads as an eye and not
            as a porthole light. */}
        <circle cx="84" cy="51" r="2" className="fill-card" />

        {/* The cargo: three across, two offset on top, the way the mark
            everybody knows stacks them. Card-filled with a coloured edge, so
            each container is a separate object sitting ON the whale rather than
            a pattern printed on it. */}
        <g
          className="fill-card"
          stroke="var(--chart-1)"
          strokeWidth="2.5"
          strokeLinejoin="round"
        >
          {[40, 54, 68].map((x) => (
            <rect key={x} x={x} y="32" width="12" height="11" rx="2" />
          ))}
          {[47, 61].map((x) => (
            <rect key={x} x={x} y="21" width="12" height="11" rx="2" />
          ))}
        </g>
      </g>
    </svg>
  );
}
