"use client";

import * as React from "react";
import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";

// The hidden-value placeholder. Matches the server-side MASK used for secrets in
// lib/data/env.ts / global-env.ts.
const MASK = "••••••••••••";

/**
 * The value cell for one env-var row — a Discord-style spoiler.
 *
 *  - plain var  → the decrypted value rides the row's props, so it sits SHARP in
 *                 the DOM but under a frosted-glass pane (Revolut-style): you can
 *                 tell there's something there, but a `backdrop-blur` smears it
 *                 past reading until you click. Click again to cover it back up.
 *                 Nothing is fetched on reveal — the value was already here.
 *  - secret var → write-only: the server sends the MASK, never the value, so there
 *                 is nothing behind the glass to uncover. It shows masked dots with
 *                 a lock and never opens.
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
        className="inline-flex max-w-[15rem] items-center gap-1.5 rounded-md bg-foreground/[0.04] px-2 py-1 align-middle ring-1 ring-inset ring-border/50"
      >
        <code className="truncate font-mono text-xs text-muted-foreground">
          {MASK}
        </code>
        <Lock className="size-3 shrink-0 text-muted-foreground/70" aria-hidden />
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
      title={revealed ? value : "Click to reveal"}
      className={cn(
        "group relative inline-flex max-w-[15rem] cursor-pointer items-center overflow-hidden rounded-md px-2 py-1 text-left align-middle ring-1 ring-inset transition-colors",
        revealed
          ? "ring-border/40 hover:bg-foreground/[0.03]"
          : "bg-foreground/[0.04] ring-border/60",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
    >
      <code
        className={cn(
          "truncate font-mono text-xs transition-colors",
          // Revealed text is selectable so the value can be copied; while it's
          // under the glass, selecting a blur would only leak it, so lock it down.
          revealed
            ? "select-text text-foreground/90"
            : "select-none text-muted-foreground",
        )}
      >
        {value}
      </code>

      {/* The frosted pane. `backdrop-blur` smears the sharp text beneath it; the
          sheen is the Revolut-style highlight raking across the glass. Mounted
          only while hidden, so the revealed value is never blurred or intercepted. */}
      {!revealed && (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-md bg-background/30 backdrop-blur-[6px]"
        >
          <span className="absolute inset-0 bg-gradient-to-br from-white/15 via-white/[0.04] to-transparent" />
        </span>
      )}
    </button>
  );
}
