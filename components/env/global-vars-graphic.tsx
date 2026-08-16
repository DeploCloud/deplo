import { cn } from "@/lib/utils";

/**
 * The All teams variables empty-state illustration: one variable at the top and
 * a beam sweeping across every team below, lighting each team's apps as it
 * passes.
 *
 * This tab is the only one whose reach is the whole instance, and the sweep is
 * what says so: it does not choose, it crosses everything. Shared next door fans
 * out to the apps you linked; this one passes over teams you may not even be a
 * member of, which is exactly why it is admin-only.
 *
 * Amber, so the three tabs of one page never read as the same picture: All is
 * `--info`, Shared is `--violet`, this is `--chart-4`. It is the decorative slot
 * the Databases drawing already spends, NOT `--warning` - a state token here
 * would tell the reader something needs attention, and nothing does.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. The beam and
 * the light-ups MUST stay in step - each team lights as the beam reaches its
 * centre, and drifting them apart turns one sweep into two unrelated animations.
 * Under `prefers-reduced-motion` it holds the swept frame: every team lit, no
 * beam.
 */
export function GlobalVarsGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A variable sweeping across every team, lighting each team's apps"
      className={cn("size-32", className)}
    >
      {/* The variable, written once above every team. Same chip the Shared
          drawing uses, so the two read as the same KIND of thing - only the
          reach below them differs. */}
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

      {/* The teams, each with its own two apps. Recessive structure: they exist
          whether or not anything is set here. */}
      <g strokeWidth="2" className="stroke-muted-foreground/40">
        <rect x="6" y="52" width="32" height="30" rx="5" />
        <rect x="44" y="52" width="32" height="30" rx="5" />
        <rect x="82" y="52" width="32" height="30" rx="5" />
      </g>
      <g
        strokeWidth="3"
        strokeLinecap="round"
        className="stroke-muted-foreground/40"
      >
        <line x1="13" y1="60" x2="24" y2="60" />
        <line x1="51" y1="60" x2="62" y2="60" />
        <line x1="89" y1="60" x2="100" y2="60" />
      </g>
      <g strokeWidth="1.75" className="stroke-muted-foreground/40">
        <rect x="12" y="67" width="9" height="9" rx="2" />
        <rect x="23" y="67" width="9" height="9" rx="2" />
        <rect x="50" y="67" width="9" height="9" rx="2" />
        <rect x="61" y="67" width="9" height="9" rx="2" />
        <rect x="88" y="67" width="9" height="9" rx="2" />
        <rect x="99" y="67" width="9" height="9" rx="2" />
      </g>

      {/* The beam. Dashed, so a still frame reads it as a scan crossing the row
          rather than as a wire hanging off the chip, and drawn before the fills
          so a team that has just lit is never overdrawn by what lit it. */}
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

      {/* What the sweep leaves behind: the variable, now in every app. One group
          per team, delayed to the moment the beam crosses it. */}
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
