import { cn } from "@/lib/utils";

/** The Deployments empty-state illustration: a crate riding a conveyor into a server, which then boots up and goes live. */
export function DeploymentGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A crate riding a conveyor into a server, which lights up and goes live"
      className={cn("size-32", className)}
    >
      <line
        x1="6"
        y1="72"
        x2="114"
        y2="72"
        className="stroke-border"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <g className="stroke-ring" strokeWidth="2" strokeLinejoin="round">
        <rect x="76" y="18" width="34" height="54" rx="4" />
        <rect x="82" y="26" width="22" height="6" rx="2" />
        <rect x="82" y="37" width="22" height="6" rx="2" />
        <rect x="82" y="48" width="22" height="6" rx="2" />
      </g>

      <g className="stroke-border" strokeWidth="1.75" strokeLinecap="round">
        <line x1="82" y1="61" x2="92" y2="61" />
        <line x1="82" y1="66" x2="92" y2="66" />
      </g>

      <g className="fill-muted-foreground">
        <circle className="deplo-deploy-bay" cx="99.5" cy="51" r="2" />
        <circle className="deplo-deploy-bay" cx="99.5" cy="40" r="2" />
        <circle className="deplo-deploy-bay" cx="99.5" cy="29" r="2" />
      </g>

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

      <g className="stroke-ring" strokeWidth="2" strokeLinecap="round">
        <circle cx="15" cy="65" r="7" />
        <circle cx="65" cy="65" r="7" />
        <line x1="15" y1="58" x2="65" y2="58" />
      </g>

      <line
        className="deplo-deploy-belt stroke-muted-foreground"
        x1="15"
        y1="58"
        x2="65"
        y2="58"
        strokeWidth="2"
      />

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
