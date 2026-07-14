"use client";

import * as React from "react";
import { Eye, EyeOff, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

// The hidden-value placeholder. Matches the server-side MASK used for secrets in
// lib/data/env.ts / global-env.ts.
const MASK = "••••••••••••";

/**
 * The value cell for one env-var row — a click-to-reveal spoiler.
 *
 *  - plain var  → the decrypted value rides the row's props, but it is NOT put in
 *                 the DOM while hidden: the covered state renders only mask dots
 *                 under a frosted-glass pane with an eye cue, so inspect-element
 *                 sees the mask, never the value. Clicking mounts the real value
 *                 (sharp, selectable); clicking again unmounts it. Nothing is
 *                 fetched on reveal — the value was already in the props.
 *  - secret var → write-only: the server sends the MASK, never the value, so there
 *                 is nothing to uncover. It shows masked dots with a lock and never
 *                 opens.
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
      // No `value` in the title while hidden either — the tooltip is a DOM
      // attribute, and this whole component's promise is that the value is
      // nowhere in the DOM until revealed.
      title={revealed ? value : "Click to reveal"}
      className={cn(
        "group relative inline-flex h-7 cursor-pointer items-center overflow-hidden rounded-md align-middle ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        revealed
          ? "max-w-[15rem] gap-1.5 px-2 ring-border/40 hover:bg-foreground/[0.03]"
          : "w-36 justify-center bg-foreground/[0.05] px-2 ring-border/60 hover:bg-foreground/[0.09]",
      )}
    >
      {revealed ? (
        <>
          <code className="select-text truncate font-mono text-xs text-foreground/90">
            {value}
          </code>
          <EyeOff
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground/70 transition-colors group-hover:text-foreground"
          />
        </>
      ) : (
        <>
          {/* Placeholder ONLY. The real value is never rendered while hidden, so
              nothing in this subtree — text or attribute — carries it. */}
          <code
            aria-hidden
            className="pointer-events-none select-none truncate font-mono text-xs tracking-widest text-muted-foreground/70"
          >
            {MASK}
          </code>
          {/* The frosted pane raking a Revolut-style sheen over the dots. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 bg-background/20 backdrop-blur-[3px]"
          >
            <span className="absolute inset-0 bg-gradient-to-br from-white/15 via-white/[0.04] to-transparent" />
          </span>
          {/* The click-to-reveal cue: a sharp eye centred on the glass. */}
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center"
          >
            <span className="flex size-5 items-center justify-center rounded-full bg-background/70 text-muted-foreground shadow-sm ring-1 ring-border/60 transition-colors group-hover:text-foreground">
              <Eye className="size-3" />
            </span>
          </span>
        </>
      )}
    </button>
  );
}
