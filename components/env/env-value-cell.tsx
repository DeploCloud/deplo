"use client";

import * as React from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

// The hidden-value placeholder. Matches the server-side MASK used for secrets in
// lib/data/env.ts / global-env.ts.
const MASK = "••••••••••••";

// One FIXED width for every state, so clicking to reveal never nudges the column
// and a long value truncates instead of stretching the cell.
const FIELD = "h-7 w-60 shrink-0";
const CHIP = `inline-flex ${FIELD} items-center gap-1.5 rounded-md px-2 align-middle ring-1 ring-inset`;

/**
 * The value cell for one env-var row — a Telegram-style spoiler.
 *
 *  - plain var  → the decrypted value rides the row's props, but it is NOT put in
 *                 the DOM while hidden: the covered state is a plain grey bar that,
 *                 on hover, fills with a drifting particle field (the Telegram
 *                 spoiler) and shows an eye. So inspect-element sees no value.
 *                 Clicking mounts the real value (truncated to the fixed width,
 *                 selectable); clicking again unmounts it.
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
    // that ends it also slam the spoiler shut.
    if (revealed && (window.getSelection()?.toString().length ?? 0) > 0) return;
    setRevealed((r) => !r);
  }

  if (masked) {
    return (
      <span
        title="Secret — hidden, and can never be read back."
        className={cn(CHIP, "bg-foreground/[0.04] ring-border/50")}
      >
        <code className="min-w-0 flex-1 truncate font-mono text-xs tracking-wider text-muted-foreground">
          {MASK}
        </code>
        <Lock className="size-3.5 shrink-0 text-muted-foreground/60" aria-hidden />
        <span className="sr-only">Secret value, hidden</span>
      </span>
    );
  }

  if (revealed) {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-pressed
        aria-label="Hide value"
        title={value}
        className={cn(
          CHIP,
          "group cursor-pointer text-left ring-border/40 transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <code className="min-w-0 flex-1 select-text truncate font-mono text-xs text-foreground/90">
          {value}
        </code>
        <EyeOff
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover:text-foreground"
        />
      </button>
    );
  }

  // Hidden: a plain light-grey bar at rest; on hover the Telegram particle field
  // drifts in and the eye cue appears. The value is never rendered here — only the
  // decorative overlays are, so inspect-element can't read it.
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={false}
      aria-label="Reveal value"
      title="Click to reveal"
      className={cn(
        "group relative inline-flex cursor-pointer items-center justify-center overflow-hidden rounded-md align-middle ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        FIELD,
        "bg-foreground/[0.06] ring-border/50 hover:bg-foreground/[0.09]",
      )}
    >
      <span aria-hidden className="env-spoiler pointer-events-none absolute inset-0" />
      <Eye
        aria-hidden
        className="relative size-3.5 text-muted-foreground opacity-0 transition-opacity duration-200 group-hover:opacity-100"
      />
    </button>
  );
}
