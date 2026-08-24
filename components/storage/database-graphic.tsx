import { cn } from "@/lib/utils";

/**
 * The Databases empty-state illustration: the outline of a database that is not
 * there, and a tumbleweed bouncing through the space where it would be.
 *
 * The dashed drum is the shape everyone reads as "database", drawn as intent
 * rather than fact - the same reason the "previews are off" branch is dashed.
 * The tumbleweed is the joke every developer already knows for "nothing here",
 * and it earns its place by moving: it blows in, skips across, leaves, and then
 * the frame sits empty for a beat before it comes round again. The pause is the
 * point. A drawing that never stops moving reads as loading.
 *
 * `--chart-4` for the weed, which is the only accent left and happens to be the
 * colour of dry hay: the set already spends `--primary` plus `--success` (Pull
 * requests, Cron jobs), `--info` (Environment variables), grey (Deployments) and
 * `--chart-3` (Backups).
 *
 * THREE nested groups, because the three motions need different easings and one
 * `transform` property cannot hold them apart:
 *
 * - `deplo-db-roll` carries it left to right, LINEAR
 * - `deplo-db-hop` is the bounce, ease-out up and ease-in down per hop
 * - `deplo-db-spin` is the rotation, LINEAR and locked to the travel
 *
 * Travel and spin must share a timing function or the weed skids; the bounce is
 * free to have its own because vertical motion does not affect the roll.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. Under
 * `prefers-reduced-motion` it parks at rest beside the drum.
 */
export function DatabaseGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="The dashed outline of a database with a tumbleweed bouncing past it"
      className={cn("size-32", className)}
    >
      {/* The ground. Full width, so the weed has somewhere to arrive from and
          somewhere to go. */}
      <line
        x1="8"
        y1="70"
        x2="112"
        y2="70"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The database that is not there: dashed, sitting ON the ground, with the
          one band that separates a drum from a plain cylinder. */}
      <g className="stroke-ring" strokeWidth="2" strokeDasharray="5 4">
        <ellipse cx="60" cy="40" rx="16" ry="5.5" />
        <path d="M44 40 L44 64.5" />
        <path d="M76 40 L76 64.5" />
        <path d="M44 64.5 A16 5.5 0 0 0 76 64.5" />
        <path d="M44 52 A16 5.5 0 0 0 76 52" />
      </g>

      {/* Placed with an SVG attribute, not CSS, so the three animated transforms
          below start from a clean slate. It begins at cx -24: every point of the
          weed is within 10.5 of its centre, so at rest it is 13.5 units clear of
          the frame and not one twig pokes back in. That margin is the whole fix
          for a weed that used to linger at the edge after it had "left". */}
      <g transform="translate(-24 61)">
        <g className="deplo-db-roll">
          <g className="deplo-db-hop">
            <g
              className="deplo-db-spin"
              stroke="var(--chart-4)"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {/* An eight-point jagged ring, radii from 7.8 to 10.5. A true
                  circle reads as a wheel or a ball; the lumps are what make it
                  a tangle of dry twigs. It touches exactly 10.5 on all four
                  sides, so the bounding box is square and centred on (0,0) -
                  which is what lets the spin use `fill-box` and still turn about
                  the real centre. */}
              <path
                d="M10.5 0 L6 6 L0 10.5 L-6.7 6.7 L-10.5 0 L-5.5 -5.5 L0 -10.5 L7.1 -7.1 Z"
                strokeWidth="1.75"
              />
              {/* The tangle inside. Thinner than the ring, so the silhouette
                  still reads first at 128px. */}
              <g strokeWidth="1.5">
                <path d="M-9 -3 L8 4" />
                <path d="M-4 -9 L5 8" />
                <path d="M-8 5 L9 -2" />
                <path d="M2 -9 L-3 9" />
              </g>
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
