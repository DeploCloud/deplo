import { cn } from "@/lib/utils";

/** The Domains empty-state illustration: a turning globe, a pin dropping onto it, and the address rippling outwards from where it lands. */
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
        <circle cx="60" cy="45" r="34" />

        <ellipse cx="60" cy="45" rx="34" ry="11.5" strokeWidth="2" />

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

      <g transform="translate(48 35)">
        <g className="deplo-domain-pin">
          <path
            d="M0 0 C-5 -6.5 -7 -8.5 -7 -11.5 A7 7 0 1 1 7 -11.5 C7 -8.5 5 -6.5 0 0 Z"
            fill="var(--violet)"
          />
          <circle cx="0" cy="-11.5" r="2.8" className="fill-card" />
        </g>
      </g>
    </svg>
  );
}
