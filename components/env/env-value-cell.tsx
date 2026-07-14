"use client";

import * as React from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

// The hidden-value placeholder. Matches the server-side MASK used for secrets in
// lib/data/env.ts / global-env.ts.
const MASK = "••••••••••••";

// The chip fills its container (the Value cell) and owns no width of its own. Its
// contents are ABSOLUTELY positioned, so a long value contributes zero intrinsic
// width to the column — the cell stays the same size whether covered or revealed,
// and the value just truncates. `h-7` gives the out-of-flow box its height.
const OUTER = "relative block h-7 w-full rounded-md align-middle ring-1 ring-inset";
const INNER = "absolute inset-0 flex items-center gap-1.5 px-2";

/**
 * The value cell for one env-var row — a click-to-reveal chip.
 *
 *  - plain var  → the decrypted value rides the row's props, but it is NOT put in
 *                 the DOM while hidden: the covered chip renders only mask dots and
 *                 an eye, so inspect-element sees the mask, never the value.
 *                 Clicking mounts the real value (truncated, selectable); clicking
 *                 again unmounts it. Nothing is fetched — the value was in props.
 *  - secret var → write-only: the server sends the MASK, never the value. Masked
 *                 dots with a lock, and it never opens.
 *
 * Each cell owns its own reveal state: a value is uncovered one row at a time,
 * deliberately, and there is no bulk "reveal all".
 */
export function EnvValueCell({
  value,
  masked,
}: {
  value: string;
  masked: boolean;
}) {
  const [revealed, setRevealed] = React.useState(false);

  function toggle() {
    // A drag to copy the value leaves a selection behind; don't let the click
    // that ends it also slam the chip shut.
    if (revealed && (window.getSelection()?.toString().length ?? 0) > 0) return;
    setRevealed((r) => !r);
  }

  if (masked) {
    return (
      <span
        title="Secret — hidden, and can never be read back."
        className={cn(OUTER, "bg-foreground/[0.04] ring-border/50")}
      >
        <span className={INNER}>
          <code className="min-w-0 flex-1 truncate font-mono text-xs tracking-wider text-muted-foreground">
            {MASK}
          </code>
          <Lock
            className="size-3.5 shrink-0 text-muted-foreground/60"
            aria-hidden
          />
        </span>
        <span className="sr-only">Secret value, hidden</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={revealed}
      aria-label={revealed ? "Hide value" : "Reveal value"}
      // No `value` in the title while hidden either — the tooltip is a DOM
      // attribute, and the whole point is that the value is nowhere in the DOM
      // until revealed.
      title={revealed ? value : "Click to reveal"}
      className={cn(
        OUTER,
        "group cursor-pointer text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        revealed
          ? "ring-border/40 hover:bg-foreground/[0.03]"
          : "bg-foreground/[0.06] ring-border/50 hover:bg-foreground/[0.09]",
      )}
    >
      <span className={INNER}>
        {revealed ? (
          <EyeOff
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
          />
        ) : (
          <Eye
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
          />
        )}
        {revealed ? (
          <code className="min-w-0 flex-1 select-text truncate font-mono text-xs text-foreground/90">
            {value}
          </code>
        ) : (
          // Placeholder ONLY. The real value is never rendered while hidden, so
          // nothing in this subtree — text or attribute — carries it.
          <code
            aria-hidden
            className="min-w-0 flex-1 select-none truncate font-mono text-xs tracking-wider text-muted-foreground"
          >
            {MASK}
          </code>
        )}
      </span>
    </button>
  );
}
