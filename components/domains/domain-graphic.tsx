import { cn } from "@/lib/utils";

/**
 * The Domains empty-state illustration: a turning globe, a pin dropping onto it,
 * and the address rippling outwards from where it lands.
 *
 * A domain is the one thing on this page that turns a container nobody can reach
 * into an address anybody can. So the drawing is exactly that: the world goes
 * round with nothing pointed at it, a pin plants, the world settles, and two rings
 * go out - your app is now somewhere. The pin is the glyph every map on earth uses
 * for "here", which is the whole reason it needs no label.
 *
 * The globe TURNS, and stops. It is still for 3.5 of the 6 seconds - the planted
 * frame is the resting state, not the moving one - which is what keeps it from
 * reading as a spinner. Both meridians are full circles squashed by `scaleX`: at
 * 1 a meridian lies on the limb, at 0 it is edge-on down the middle, and negative
 * values are the far side coming back round. Each one ends the loop on the MIRROR
 * of the value it started on, and a mirrored ellipse draws identically, so the
 * loop closes with no visible jump.
 *
 * `--violet`, which no other drawing in the set spends - Deployments is grey,
 * Variables is `--info`, Pull requests and Cron jobs are `--primary` plus
 * `--success`, Backups `--chart-3`, Databases `--chart-4`, S3 `--chart-5`, backup
 * schedules `--chart-1`. It is a token, not a hex: the palette had no purple, and
 * a colour written into a component is a colour that is wrong in one of the two
 * themes. Deliberately NOT a sixth chart slot - those five are a categorical set
 * for real data, and this is decoration.
 *
 * No padlock, deliberately, even though these domains get automatic TLS: the
 * Environment variables drawing already spends the padlock on encryption, and the
 * same symbol on two tabs teaches neither. The address is this page's story.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. Under
 * `prefers-reduced-motion` it holds the planted frame.
 */
export function DomainGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A pin landing on a globe, with a signal rippling out from it"
      className={cn("size-32", className)}
    >
      <g className="stroke-ring" strokeWidth="2.5" strokeLinecap="round">
        {/* The world: always there, never fading. It is what a domain is added
            TO, so it is structure, and the pin is the subject. */}
        <circle cx="60" cy="45" r="34" />

        {/* The equator, which is what makes a circle read as a sphere seen from
            slightly above rather than as a ring. Static: it is the one line the
            turn would not move. */}
        <ellipse cx="60" cy="45" rx="34" ry="11.5" strokeWidth="2" />

        {/* The two meridians, drawn as full circles and squashed by the animation
            below - hence rx = ry = the globe's own radius. */}
        <ellipse
          className="deplo-domain-meridian-a"
          cx="60"
          cy="45"
          rx="34"
          ry="34"
          strokeWidth="2"
        />
        <ellipse
          className="deplo-domain-meridian-b"
          cx="60"
          cy="45"
          rx="34"
          ry="34"
          strokeWidth="2"
        />
      </g>

      {/* The address going out. Centred on the pin's TIP, because that is the
          point on the map the name now resolves to, and drawn BEFORE the pin so
          the rings come out from behind it. `non-scaling-stroke` keeps them
          ripples instead of thickening into blobs as they expand - and it goes on
          each circle, NOT on the group: it is not an inherited property, so a
          group-level one silently does nothing. */}
      <g stroke="var(--violet)" strokeWidth="2">
        <circle
          className="deplo-domain-ping"
          cx="48"
          cy="35"
          r="7"
          vectorEffect="non-scaling-stroke"
        />
        <circle
          className="deplo-domain-ping"
          cx="48"
          cy="35"
          r="7"
          vectorEffect="non-scaling-stroke"
        />
      </g>

      {/* The pin. Placed with an SVG attribute and authored around its own tip,
          so the drop animation is a plain translate from above and lands the tip
          exactly on the point the rings come out of. It plants a unit below the
          equator arc, which at that x reads as the ground it stands on. */}
      <g transform="translate(48 35)">
        <g className="deplo-domain-pin">
          <path
            d="M0 0 C-5 -6.5 -7 -8.5 -7 -11.5 A7 7 0 1 1 7 -11.5 C7 -8.5 5 -6.5 0 0 Z"
            fill="var(--violet)"
          />
          {/* The hole. Card-coloured rather than transparent, so the meridian
              sliding past behind the pin never shows through it. */}
          <circle cx="0" cy="-11.5" r="2.8" className="fill-card" />
        </g>
      </g>
    </svg>
  );
}
