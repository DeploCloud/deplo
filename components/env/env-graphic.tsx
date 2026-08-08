import { cn } from "@/lib/utils";

/**
 * The environment variables empty-state illustration: an empty list, one
 * variable being written into it, and its value masked the moment it lands.
 *
 * `KEY = ****` is the shape everyone already reads as "environment variable", so
 * the drawing says what belongs here before the heading does. The masking is not
 * decoration: a value is write-only in Deplo the second it is stored, and a
 * drawing that showed readable text would promise a reveal that does not exist.
 *
 * Same grammar as the Pull requests and Cron jobs drawings - recessive muted
 * structure, one accent for the subject - but a DIFFERENT accent on purpose.
 * Those two spend `--primary` and `--success`; this one is `--info`, so three
 * empty states in the same product do not all read as the same picture.
 *
 * Pure SVG + CSS keyframes (see globals.css), no JS and no library. Colours are
 * tokens, so both themes are right without a second asset, and under
 * `prefers-reduced-motion` it holds the written frame rather than an empty box.
 */
export function EnvGraphic({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 90"
      fill="none"
      role="img"
      aria-label="A variable being written into an empty list, its value masked as it lands"
      className={cn("size-32", className)}
    >
      {/* The list itself: what is already there, waiting. Recessive and never
          animated, so the eye goes to the row being written. */}
      <rect
        x="10"
        y="17"
        width="100"
        height="56"
        rx="10"
        className="stroke-muted-foreground/40"
        strokeWidth="2.5"
      />

      {/* The equals. Muted because it is grammar, not content - it is the same
          on every row that will ever land here. */}
      <g
        className="stroke-muted-foreground/40"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <line x1="54" y1="41" x2="61" y2="41" />
        <line x1="54" y1="49" x2="61" y2="49" />
      </g>

      {/* The name, drawing itself left to right the way it is typed. */}
      <line
        x1="24"
        y1="45"
        x2="46"
        y2="45"
        className="deplo-env-key"
        stroke="var(--info)"
        strokeWidth="6"
        strokeLinecap="round"
      />

      {/* The value, arriving already masked. Four dots at 10 apart: at r=3.5
          anything tighter fuses into one bar and stops reading as characters.
          `fill-opacity` sits under the animated `opacity`, so the two multiply
          and the dots stay a shade behind the name they belong to. */}
      <g fill="var(--info)" fillOpacity="0.7">
        <circle cx="70" cy="45" r="3.5" className="deplo-env-dot" />
        <circle cx="80" cy="45" r="3.5" className="deplo-env-dot" />
        <circle cx="90" cy="45" r="3.5" className="deplo-env-dot" />
        <circle cx="100" cy="45" r="3.5" className="deplo-env-dot" />
      </g>
    </svg>
  );
}
