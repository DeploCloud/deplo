import { cn } from "@/lib/utils";

/**
 * The Databases empty-state illustration: the outline of a database that is not
 * there, and a tumbleweed rolling through the space where it would be.
 *
 * The dashed drum is the shape everyone reads as "database", drawn as intent
 * rather than fact - the same reason the "previews are off" branch is dashed.
 * The tumbleweed is the joke every developer already knows for "nothing here",
 * and it earns its place by moving: it rolls in, crosses, leaves, and then the
 * frame sits empty for a beat before it comes round again. The pause is the
 * point. A drawing that never stops moving reads as loading.
 *
 * `--chart-4` for the weed, which is the only accent left and happens to be the
 * colour of dry hay: the set already spends `--primary` plus `--success` (Pull
 * requests, Cron jobs), `--info` (Environment variables), grey (Deployments) and
 * `--chart-3` (Backups).
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. The roll is
 * one transform doing both jobs, and the rotation is derived from the distance
 * so the weed never looks like it is skidding. Under `prefers-reduced-motion` it
 * parks at rest beside the drum instead of off-screen, which would leave the
 * frame looking broken rather than empty.
 */
export function DatabaseGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="The dashed outline of a database with a tumbleweed rolling past it"
      className={cn("size-32", className)}
    >
      {/* The ground. Full width, so the weed has somewhere to arrive from and
          somewhere to go. */}
      <line
        x1="8"
        y1="70"
        x2="112"
        y2="70"
        className="stroke-muted-foreground/40"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The database that is not there: dashed, sitting ON the ground, with the
          one band that separates a drum from a plain cylinder. */}
      <g
        className="stroke-muted-foreground/40"
        strokeWidth="2"
        strokeDasharray="5 4"
      >
        <ellipse cx="60" cy="40" rx="16" ry="5.5" />
        <path d="M44 40 L44 64.5" />
        <path d="M76 40 L76 64.5" />
        <path d="M44 64.5 A16 5.5 0 0 0 76 64.5" />
        <path d="M44 52 A16 5.5 0 0 0 76 52" />
      </g>

      {/* The tumbleweed, drawn last so it rolls in FRONT of the drum. Authored
          off the left edge (cx -12, r 9), so it enters and leaves rather than
          appearing. The crossing twigs are what stop a circle from reading as a
          ball or a wheel. */}
      <g
        className="deplo-db-tumble"
        stroke="var(--chart-4)"
        strokeWidth="1.75"
        strokeLinecap="round"
      >
        <circle cx="-12" cy="61" r="9" />
        <path d="M-20 57 L-4 65" />
        <path d="M-20 65 L-4 57" />
        <path d="M-12 52 L-12 70" />
        <path d="M-21 61 L-3 61" />
        {/* Two twigs poking out of the tangle, so the silhouette is scruffy
            rather than perfectly round. */}
        <path d="M-3 55 L2 52" />
        <path d="M-19 68 L-23 71" />
      </g>
    </svg>
  );
}
