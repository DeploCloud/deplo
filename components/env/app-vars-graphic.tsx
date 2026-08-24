import { cn } from "@/lib/utils";

/**
 * The All (per-app) variables empty-state illustration: three app cards, each
 * taking delivery of its OWN variable, one after another.
 *
 * The tab's whole idea is that variables belong to an app, not to the page:
 * three cards filling one at a time say that before the heading does, and it is
 * what separates this drawing from the Shared one next door, where a single
 * definition fans OUT to many apps.
 *
 * `--info`, the same accent `EnvGraphic` spends, because it is the same thing
 * being drawn - a variable. The key is full strength and the masked value sits
 * at 0.65, so the row reads as "name, then something hidden" at a glance.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library, so it costs
 * one paint and renders in a server component. Under `prefers-reduced-motion` it
 * holds the filled frame: every card with its variable.
 */
export function AppVarsGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="Three app cards, each receiving its own environment variable"
      className={cn("size-32", className)}
    >
      {/* The cards: already there before anything is set, so they are recessive
          structure and never move. The short bar is the app's name. */}
      <g strokeWidth="2" className="stroke-ring">
        <rect x="6" y="22" width="32" height="46" rx="5" />
        <rect x="44" y="22" width="32" height="46" rx="5" />
        <rect x="82" y="22" width="32" height="46" rx="5" />
      </g>
      <g strokeWidth="3" strokeLinecap="round" className="stroke-border">
        <line x1="13" y1="32" x2="25" y2="32" />
        <line x1="51" y1="32" x2="63" y2="32" />
        <line x1="89" y1="32" x2="101" y2="32" />
      </g>

      {/* The variables, dropping in card by card - `nth-child`, so document
          order is the order they land. Key lengths differ because real names do;
          three identical bars read as a loading skeleton. */}
      <g>
        <g className="deplo-avars-row">
          <line
            x1="13"
            y1="46"
            x2="27"
            y2="46"
            stroke="var(--info)"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <g fill="var(--info)" fillOpacity="0.65">
            <circle cx="15" cy="57" r="2.4" />
            <circle cx="22" cy="57" r="2.4" />
            <circle cx="29" cy="57" r="2.4" />
          </g>
        </g>
        <g className="deplo-avars-row">
          <line
            x1="51"
            y1="46"
            x2="69"
            y2="46"
            stroke="var(--info)"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <g fill="var(--info)" fillOpacity="0.65">
            <circle cx="53" cy="57" r="2.4" />
            <circle cx="60" cy="57" r="2.4" />
            <circle cx="67" cy="57" r="2.4" />
          </g>
        </g>
        <g className="deplo-avars-row">
          <line
            x1="89"
            y1="46"
            x2="100"
            y2="46"
            stroke="var(--info)"
            strokeWidth="5"
            strokeLinecap="round"
          />
          <g fill="var(--info)" fillOpacity="0.65">
            <circle cx="91" cy="57" r="2.4" />
            <circle cx="98" cy="57" r="2.4" />
            <circle cx="105" cy="57" r="2.4" />
          </g>
        </g>
      </g>
    </svg>
  );
}
