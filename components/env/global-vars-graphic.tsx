import { cn } from "@/lib/utils";

/** The All teams variables empty-state illustration: one variable at the top and a beam sweeping across every team below, lighting each team's apps as it passes. */
export function GlobalVarsGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A variable sweeping across every team, lighting each team's apps"
      className={cn("size-32", className)}
    >
      <rect
        x="42"
        y="6"
        width="36"
        height="20"
        rx="5"
        stroke="var(--chart-4)"
        strokeWidth="2"
      />
      <line
        x1="48"
        y1="16"
        x2="58"
        y2="16"
        stroke="var(--chart-4)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <g fill="var(--chart-4)" fillOpacity="0.65">
        <circle cx="65" cy="16" r="2" />
        <circle cx="71" cy="16" r="2" />
      </g>

      <g strokeWidth="2" className="stroke-ring">
        <rect x="6" y="52" width="32" height="30" rx="5" />
        <rect x="44" y="52" width="32" height="30" rx="5" />
        <rect x="82" y="52" width="32" height="30" rx="5" />
      </g>
      <g strokeWidth="3" strokeLinecap="round" className="stroke-border">
        <line x1="13" y1="60" x2="24" y2="60" />
        <line x1="51" y1="60" x2="62" y2="60" />
        <line x1="89" y1="60" x2="100" y2="60" />
      </g>
      <g strokeWidth="1.75" className="stroke-border">
        <rect x="12" y="67" width="9" height="9" rx="2" />
        <rect x="23" y="67" width="9" height="9" rx="2" />
        <rect x="50" y="67" width="9" height="9" rx="2" />
        <rect x="61" y="67" width="9" height="9" rx="2" />
        <rect x="88" y="67" width="9" height="9" rx="2" />
        <rect x="99" y="67" width="9" height="9" rx="2" />
      </g>

      <line
        className="deplo-gvars-beam"
        x1="60"
        y1="38"
        x2="60"
        y2="86"
        stroke="var(--chart-4)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />

      <g fill="var(--chart-4)">
        <g className="deplo-gvars-team">
          <rect x="12" y="67" width="9" height="9" rx="2" />
          <rect x="23" y="67" width="9" height="9" rx="2" />
        </g>
        <g className="deplo-gvars-team">
          <rect x="50" y="67" width="9" height="9" rx="2" />
          <rect x="61" y="67" width="9" height="9" rx="2" />
        </g>
        <g className="deplo-gvars-team">
          <rect x="88" y="67" width="9" height="9" rx="2" />
          <rect x="99" y="67" width="9" height="9" rx="2" />
        </g>
      </g>
    </svg>
  );
}
