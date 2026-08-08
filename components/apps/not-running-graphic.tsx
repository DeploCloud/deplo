import { cn } from "@/lib/utils";

/**
 * The "app is not running" empty-state illustration: a plug hanging out of its
 * socket, swinging slowly, dipping towards the socket and never going in.
 *
 * An app that is not running is not broken and not busy - it is simply not
 * connected to anything, which is exactly what an unplugged plug says without a
 * word of explanation. The slow swing is the point: it is the motion of a thing
 * nobody is using. And the dip that stalls a couple of units short of the socket
 * is the same gesture the "previews are off" branch makes - this could be
 * happening, and is not. Two drawings that share a grammar teach one idea.
 *
 * Entirely GREY, no accent at all. "Not running" is the state the product paints
 * grey everywhere else (`AppStatusBadge` reserves red for `error`/`failed`), so a
 * coloured drawing here would contradict the badge sitting a few pixels away. The
 * socket is structure at 40% - it is the thing that was already there - and the
 * plug is the subject at full `--muted-foreground`.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. Two nested
 * groups, because the swing turns about the top of the cord while the dip runs
 * DOWN the cord, and one `transform` property cannot hold both. Under
 * `prefers-reduced-motion` it hangs still, straight over the socket.
 */
export function NotRunningGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A plug hanging unplugged above its socket"
      className={cn("size-32", className)}
    >
      {/* The wall's skirting. It carries no meaning on its own - it is there so a
          tall thin drawing has a floor to hang over instead of floating in the
          middle of a wide frame. */}
      <line
        x1="8"
        y1="86"
        x2="112"
        y2="86"
        className="stroke-muted-foreground/40"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      {/* The socket: always there, never animated, waiting to be used. Two
          vertical slots and the earth hole below them - the arrangement everyone
          has looked at a thousand times, which is what makes it need no label. */}
      <g className="stroke-muted-foreground/40" strokeWidth="2.5">
        <rect x="42" y="65" width="36" height="18" rx="4.5" />
        <g strokeLinecap="round">
          <line x1="54" y1="69" x2="54" y2="75.5" />
          <line x1="66" y1="69" x2="66" y2="75.5" />
        </g>
      </g>
      <circle cx="60" cy="79.5" r="2" className="fill-muted-foreground/40" />

      {/* The plug, hanging from off the top of the frame. The swing turns the
          whole thing about the point the cord leaves the frame; the dip inside it
          slides down the cord and back. */}
      <g className="deplo-plug-sway">
        <g className="deplo-plug-dip">
          <g
            className="stroke-muted-foreground"
            strokeWidth="2.5"
            strokeLinecap="round"
          >
            {/* Slack, and it leaves heading sideways. A cord that ends going
                straight up reads as CUT; one that curls away reads as carrying on
                past the drawing, which is what it does - and the bow is what makes
                it flex rather than a rod bolted to the ceiling. */}
            <path d="M40 5 C55 7, 65 19, 60 34" />

            <rect x="49" y="34" width="22" height="17" rx="4" />

            {/* The prongs, on the same two x as the slots below them - so when the
                plug dips, what stops it reading as plugged in is the gap, not a
                misalignment the eye has to hunt for. */}
            <line x1="54" y1="51" x2="54" y2="58" />
            <line x1="66" y1="51" x2="66" y2="58" />
          </g>

          {/* The seam. One line is the difference between a moulded plug and a
              rounded rectangle. */}
          <line
            x1="49"
            y1="43"
            x2="71"
            y2="43"
            className="stroke-muted-foreground"
            strokeWidth="2"
          />
        </g>
      </g>
    </svg>
  );
}
