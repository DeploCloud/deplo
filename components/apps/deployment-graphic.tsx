import { cn } from "@/lib/utils";

/**
 * The Deployments empty-state illustration: a build riding the pipeline, the
 * track filling in behind it, and the moment it goes live at the far end.
 *
 * A deployment is the one thing on this page that is a JOURNEY rather than a
 * record, so the drawing is the journey: something leaves, something fills in
 * behind it, and it lands. A static rocket said "deploy" as a word; this says
 * what actually happens, and an empty list that keeps showing it reads as
 * waiting rather than broken.
 *
 * The only one in the set with no accent colour at all: the whole drawing is
 * grey, the moving parts at full `--muted-foreground` against a track at 40%.
 * One hue and two weights of it still separate the subject from the structure,
 * and a deployment is the one thing here that already carries its own colour
 * elsewhere in the product (the status badges), so the empty state stays out of
 * that conversation.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. The package
 * and the track fill share one linear 5s timeline, which is what keeps the
 * leading edge under the package instead of drifting away from it. Under
 * `prefers-reduced-motion` it holds the landed frame.
 */
export function DeploymentGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A build travelling along a pipeline and going live at the end"
      className={cn("size-32", className)}
    >
      {/* The pipeline: always there, waiting for something to send down it. */}
      <line
        x1="18"
        y1="60"
        x2="96"
        y2="60"
        className="stroke-muted-foreground/40"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The moment it goes live, drawn FIRST so the ring comes out from behind
          the package rather than over it. `non-scaling-stroke` keeps it a ripple
          instead of thickening into a blob as it expands. */}
      <circle
        cx="96"
        cy="53"
        r="9"
        className="deplo-deploy-land stroke-muted-foreground"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />

      {/* How far it has got. Same line, same length, drawn on top. */}
      <line
        x1="18"
        y1="60"
        x2="96"
        y2="60"
        className="deplo-deploy-fill stroke-muted-foreground"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The build itself, riding on the track rather than floating above it -
          its bottom edge IS the line, which is what makes the two read as one
          moving thing. */}
      <rect
        x="11"
        y="46"
        width="14"
        height="14"
        rx="3.5"
        className="deplo-deploy-package fill-muted-foreground"
      />
    </svg>
  );
}
