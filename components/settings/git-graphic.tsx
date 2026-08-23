import { cn } from "@/lib/utils";

/**
 * The Git empty-state illustration: a repository being cloned across. A copy
 * detaches from the host your code already lives on, glides over, and dissolves
 * into a list that fills behind it.
 *
 * That is the whole page in one picture. You connect a host; its repositories
 * become things deplo can clone and deploy. The source panel is drawn full from
 * the first frame and never animates - it is what already exists, and it is
 * still full after the copy leaves, because cloning takes nothing away.
 *
 * Three obvious git images were deliberately NOT used, because each already
 * means something else in this product: a branch graph is Pull requests, a plug
 * is "app is not running" (where it means a thing that never connects, the
 * opposite of this), and a padlock is Environment variables. The same drawing on
 * two screens teaches neither.
 *
 * It also has to stay clear of the Deployments drawing, which is the other one
 * that moves an object left to right. Four things keep them apart:
 *
 *   - This DUPLICATES; that transports. The source here is still full once the
 *     copy has gone, and a crate on a belt leaves nothing behind.
 *   - No belt and no rack. The guide line is thin, dashed and NEVER animates;
 *     what makes the Deployments belt a conveyor is its moving tread.
 *   - The destination is a list that fills, not a rack whose bays light up.
 *   - Deployments is entirely grey. This is `--violet` - the token documented in
 *     globals.css as the one decorative accent, spent by the empty states with
 *     no status to report. It is a token and not a hex, so both themes are right
 *     without a second asset, and it is not `--success`: a status colour on a
 *     drawing with no status is a promise the page cannot keep.
 *
 * The copy fades out over the first rows drawing in, so it reads as dissolving
 * INTO the list rather than parking on top of it. The rows draw left to right on
 * `stroke-dashoffset` - the dot is filled, so the dash pattern passes it by -
 * staggered 0.25s, which turns three rows into a list filling in rather than
 * three things blinking at once.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. Under
 * `prefers-reduced-motion` it holds the landed frame: copy gone, both panels
 * full.
 */
export function GitGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A repository being copied from a git host into a list of repositories"
      className={cn("size-32", className)}
    >
      {/* The guide the copy travels along. Dashed, recessive and STATIC - the
          moment it moves it stops being a hint and becomes a conveyor. Drawn
          first so the panels and the copy both sit over it. */}
      <line
        x1="50"
        y1="45"
        x2="70"
        y2="45"
        className="stroke-border"
        strokeWidth="2"
        strokeDasharray="3 5"
        strokeLinecap="round"
      />

      {/* The host your code is already on. Full from the first frame and never
          animated: it is the thing that exists before you do anything. */}
      <rect
        x="4"
        y="14"
        width="44"
        height="62"
        rx="10"
        className="stroke-ring"
        strokeWidth="2.5"
      />
      <g className="fill-ring" strokeLinecap="round">
        {[29, 45, 61].map((y) => (
          <g key={y}>
            <circle cx="15" cy={y} r="3" />
            <line
              x1="22"
              y1={y}
              x2="40"
              y2={y}
              className="stroke-ring"
              strokeWidth="5"
            />
          </g>
        ))}
      </g>

      {/* Where they land. Empty at rest, which is what the empty state is. */}
      <rect
        x="72"
        y="14"
        width="44"
        height="62"
        rx="10"
        className="stroke-ring"
        strokeWidth="2.5"
      />

      {/* The repositories arriving. The dash pattern is set in CSS at 18, the
          bar's exact length, so a row draws itself outwards from its dot rather
          than fading in. */}
      <g strokeLinecap="round">
        {[29, 45, 61].map((y) => (
          <g key={y} className="deplo-git-row">
            <circle cx="83" cy={y} r="3" fill="var(--violet)" />
            <line
              x1="90"
              y1={y}
              x2="108"
              y2={y}
              stroke="var(--violet)"
              strokeWidth="5"
            />
          </g>
        ))}
      </g>

      {/* The copy. Authored over the source and translated 68 units, which is
          exactly the gap between the two panels' centres, so it lands centred in
          the destination rather than near it. Card-filled, not transparent: it
          has to occlude the guide line it passes over, or it reads as a label on
          the wire instead of an object on it. */}
      <g className="deplo-git-copy">
        <rect
          x="8"
          y="35"
          width="36"
          height="20"
          rx="6"
          className="fill-card"
          stroke="var(--violet)"
          strokeWidth="2.5"
        />
        <circle cx="17" cy="45" r="2.5" fill="var(--violet)" />
        <line
          x1="24"
          y1="45"
          x2="40"
          y2="45"
          stroke="var(--violet)"
          strokeWidth="3.5"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}
