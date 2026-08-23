import { cn } from "@/lib/utils";

/**
 * The "catalog unreachable" illustration: a request leaving this instance,
 * climbing toward the template service, and dying at a broken link.
 *
 * The state is an ERROR, not an absence, so this is the one empty-state drawing
 * in destructive colour - the cloud that cannot answer and the break itself.
 * The instance and the wire stay muted, because nothing is wrong on this side:
 * the drawing has to say "we tried and could not get there", which is also why
 * the request keeps setting off again. A single crossed-out cloud would say
 * "offline" and stop there.
 *
 * Same grammar as `NoResultsGraphic` next door: recessive muted structure, one
 * moving subject, one beat where the thing happens. Pure SVG + CSS keyframes
 * (see globals.css), no JS and no library, so it costs one paint and renders in
 * a server component. Under `prefers-reduced-motion` it holds the failed frame.
 *
 * The cloud is lucide's own `cloud` path, scaled up: the page's icon was
 * `CloudOff` and the store is full of lucide glyphs, so borrowing the shape
 * keeps this in the same hand instead of inventing a second cloud.
 */
export function CatalogOfflineGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      role="img"
      aria-label="A request rising from this instance toward the template catalog and stopping at a broken connection"
      className={cn("size-32", className)}
    >
      {/* The catalog service. `non-scaling-stroke`, or the 2.6x blow-up would
          take the stroke with it and turn a 2.5-unit outline into a 6.5 one. */}
      <path
        className="deplo-offline-cloud stroke-destructive/80"
        d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"
        transform="translate(28.8 -7) scale(2.6)"
        strokeWidth="2.5"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />

      {/* The wire, in two pieces with the break between them. Dashed, because a
          dashed line is what every network diagram means by "a hop", and muted
          because this half of the picture is not what failed. */}
      <g
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray="2 6"
      >
        <line x1="60" y1="44" x2="60" y2="54" />
        <line x1="60" y1="72" x2="60" y2="92" />
      </g>

      {/* This instance: the only thing in the drawing that is definitely fine,
          so it never moves and never changes colour. */}
      <g className="stroke-ring" strokeWidth="2.5">
        <rect x="38" y="96" width="44" height="20" rx="5" />
        {/* One lit pin, so the box reads as a machine and not as a card. */}
        <line x1="46" y1="106" x2="46" y2="106" strokeLinecap="round" />
      </g>

      {/* The request. It starts inside the box and rises the full length of the
          wire, so the eye is already travelling when it hits the break. */}
      <rect
        className="deplo-offline-packet fill-destructive"
        x="56"
        y="74"
        width="8"
        height="8"
        rx="2"
      />

      {/* The break. It pops in at the moment of impact rather than sitting
          there, which is what makes this one failed attempt instead of a
          permanent hole in the picture. */}
      <g
        className="deplo-offline-break stroke-destructive"
        strokeWidth="3.5"
        strokeLinecap="round"
      >
        <line x1="52" y1="55" x2="68" y2="71" />
        <line x1="68" y1="55" x2="52" y2="71" />
      </g>
    </svg>
  );
}
