import { cn } from "@/lib/utils";

/**
 * The Backup artifacts empty-state illustration: copies landing on a shelf, one
 * after another, building the stack the list will show.
 *
 * "Artifacts" is a list of things that ACCUMULATE, so the drawing accumulates:
 * three copies drop onto the shelf bottom to top, the oldest sitting dimmest at
 * the bottom. That is the whole shape of the page - a pile that gets deeper
 * every time a backup finishes.
 *
 * `--chart-3`, the one accent the set has not spent: Pull requests and Cron jobs
 * are `--primary` plus `--success`, Environment variables is `--info`, and
 * Deployments is grey. Green was the tempting pick here and is taken; it also
 * belongs to "succeeded", which a backup run has its own badge for.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. The drop is
 * a plain translate with no bounce, matching the rest of the set, and under
 * `prefers-reduced-motion` it holds the stacked frame.
 */
export function BackupGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="Copies landing one after another on a shelf, building a stack"
      className={cn("size-32", className)}
    >
      {/* The shelf: the destination, already there and waiting. Wider than the
          stack on both sides, so the copies read as landing ON it. */}
      <line
        x1="22"
        y1="70"
        x2="98"
        y2="70"
        className="stroke-muted-foreground/40"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* Bottom to top, oldest to newest. The fill opacities are the depth cue:
          a flat stack of three identical slabs reads as one striped block. */}
      <g fill="var(--chart-3)">
        <rect
          x="30"
          y="58"
          width="60"
          height="12"
          rx="3"
          className="deplo-backup-slab"
          fillOpacity="0.5"
        />
        <rect
          x="30"
          y="44"
          width="60"
          height="12"
          rx="3"
          className="deplo-backup-slab"
          fillOpacity="0.75"
        />
        <rect
          x="30"
          y="30"
          width="60"
          height="12"
          rx="3"
          className="deplo-backup-slab"
        />
      </g>
    </svg>
  );
}
