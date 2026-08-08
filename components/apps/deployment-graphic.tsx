import { cn } from "@/lib/utils";

/**
 * The Deployments empty-state illustration: a crate riding a conveyor into a
 * server, which then boots up and goes live.
 *
 * A deployment is the one thing on this page that is a JOURNEY rather than a
 * record, and the journey has two ends worth drawing: your build, and the
 * machine that ends up running it. The abstract version of this - a square
 * sliding along a line - said "something moves" and nothing else. A parcel on a
 * belt arriving at a rack whose bays light up bottom to top says what deplo
 * actually does with a push, before the heading gets a chance to.
 *
 * The rest beat matters as much as the motion: the crate is handed over, the
 * bays come on, the power light goes green, everything clears, and the frame
 * sits dark for a moment. A drawing that never stops moving reads as loading.
 *
 * Structure at 40% (ground, belt, rack, empty bays), the moving parts at full
 * `--muted-foreground`, and one `--success` beat for the moment it is live -
 * the same green the merge dot and the cron fire get, since it is the same kind
 * of moment. Nothing else is coloured: a deployment already owns a palette
 * elsewhere in the product (the status badges) and the empty state stays out of
 * that conversation.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. The crate
 * and the belt tread MUST cover the same 50 units over the same window or the
 * crate visibly skids on the belt - same constraint as the tumbleweed's roll and
 * spin. Under `prefers-reduced-motion` it holds the finished frame: crate on the
 * belt, rack lit.
 */
export function DeploymentGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A crate riding a conveyor into a server, which lights up and goes live"
      className={cn("size-32", className)}
    >
      {/* The ground both machines stand on. Wider than either, so the belt reads
          as sitting on it rather than floating. */}
      <line
        x1="6"
        y1="72"
        x2="114"
        y2="72"
        className="stroke-muted-foreground/40"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The server: the destination, already there before anything is deployed,
          so it is drawn as recessive structure. Three empty bays waiting for
          something to run in them. */}
      <g
        className="stroke-muted-foreground/40"
        strokeWidth="2"
        strokeLinejoin="round"
      >
        <rect x="76" y="18" width="34" height="54" rx="4" />
        <rect x="82" y="26" width="22" height="6" rx="2" />
        <rect x="82" y="37" width="22" height="6" rx="2" />
        <rect x="82" y="48" width="22" height="6" rx="2" />
      </g>

      {/* Vents. Two thin lines are the whole difference between a rounded
          rectangle and a machine. */}
      <g
        className="stroke-muted-foreground/30"
        strokeWidth="1.75"
        strokeLinecap="round"
      >
        <line x1="82" y1="61" x2="92" y2="61" />
        <line x1="82" y1="66" x2="92" y2="66" />
      </g>

      {/* The bays coming up, BOTTOM FIRST - the stagger is `nth-child`, so
          document order is the order they light. */}
      <g className="fill-muted-foreground">
        <circle className="deplo-deploy-bay" cx="99.5" cy="51" r="2" />
        <circle className="deplo-deploy-bay" cx="99.5" cy="40" r="2" />
        <circle className="deplo-deploy-bay" cx="99.5" cy="29" r="2" />
      </g>

      {/* Live. The ring is drawn first so it comes out from behind the power
          light rather than over it, and `non-scaling-stroke` keeps it a ripple
          instead of thickening into a blob as it expands. */}
      <circle
        className="deplo-deploy-signal"
        cx="100"
        cy="64"
        r="5"
        stroke="var(--success)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
      <circle
        className="deplo-deploy-live"
        cx="100"
        cy="64"
        r="3"
        fill="var(--success)"
      />

      {/* The conveyor: two pulleys with the belt surface tangent across their
          tops and the ground doubling as the return side. */}
      <g
        className="stroke-muted-foreground/40"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="15" cy="65" r="7" />
        <circle cx="65" cy="65" r="7" />
        <line x1="15" y1="58" x2="65" y2="58" />
      </g>

      {/* The tread. Dashes scrolling along the surface are what make the belt
          read as running; butt caps, because rounded ones turn every dash into a
          pill. */}
      <line
        className="deplo-deploy-belt stroke-muted-foreground/70"
        x1="15"
        y1="58"
        x2="65"
        y2="58"
        strokeWidth="2"
      />

      {/* The build itself: a parcel, lid and tape and all, sitting ON the belt -
          its bottom edge IS the surface line, which is what makes the two read
          as one moving thing. Filled, so the tread does not show through it. */}
      <g className="deplo-deploy-crate">
        <rect
          x="8"
          y="42"
          width="16"
          height="16"
          rx="2"
          className="fill-card stroke-muted-foreground"
          strokeWidth="2"
        />
        <g className="stroke-muted-foreground" strokeWidth="2">
          <line x1="8" y1="48.5" x2="24" y2="48.5" />
          <line x1="16" y1="42" x2="16" y2="48.5" />
        </g>
      </g>
    </svg>
  );
}
