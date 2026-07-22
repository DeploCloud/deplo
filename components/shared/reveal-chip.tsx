"use client";

import * as React from "react";
import { Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

// The hidden-value placeholder. Matches the server-side MASK used for secrets in
// lib/data/env.ts / global-env.ts.
export const REVEAL_MASK = "••••••••••••";

// The chip fills its container and owns no width of its own. Its contents are
// ABSOLUTELY positioned, so a long value contributes zero intrinsic width — the
// chip stays the same size whether covered or revealed, and the value just
// truncates. `h-7` gives the out-of-flow box its height.
const OUTER = "relative block h-7 w-full rounded-md align-middle ring-1 ring-inset";
const INNER = "absolute inset-0 flex items-center gap-1.5 px-2";

/**
 * The click-to-reveal chip — one covered value with an eye toggle.
 *
 * The invariant that makes it safe: **while covered, the real value is not in
 * the DOM at all**. The chip renders only the placeholder (mask dots, or a
 * partially-masked hint like a connection string with its password blanked),
 * and even the `title` attribute stays generic — inspect-element sees the mask,
 * never the value. Revealing mounts the value; hiding unmounts it.
 *
 * Three shapes:
 *  - interactive — `onToggle` flips `revealed`; `value` is rendered only then.
 *  - `locked`    — a secret the server will never hand back: dots + a padlock,
 *                  and it never opens.
 *  - `readOnly`  — the placeholder alone, no affordance (the viewer lacks the
 *                  capability to reveal it).
 *
 * Callers own the reveal state, so a value is uncovered one chip at a time,
 * deliberately, and there is never a bulk "reveal all".
 */
export function RevealChip({
  value = null,
  revealed = false,
  onToggle,
  placeholder = REVEAL_MASK,
  placeholderClassName,
  pending = false,
  locked = false,
  lockedHint = "Secret — hidden, and can never be read back.",
  readOnly = false,
  labels = { reveal: "Reveal value", hide: "Hide value" },
  className,
}: {
  /** The real value. Pass it only when it may legitimately be revealed. */
  value?: string | null;
  revealed?: boolean;
  onToggle?: () => void;
  /** What stands in for the value while it is covered. */
  placeholder?: string;
  placeholderClassName?: string;
  /** The value is being fetched — the chip is inert and spins. */
  pending?: boolean;
  /** Write-only secret: masked with a padlock, never openable. */
  locked?: boolean;
  lockedHint?: string;
  /** No reveal affordance at all (missing capability). */
  readOnly?: boolean;
  labels?: { reveal: string; hide: string };
  className?: string;
}) {
  function handleClick() {
    // A drag to copy the value leaves a selection behind; don't let the click
    // that ends it also slam the chip shut.
    if (revealed && (window.getSelection()?.toString().length ?? 0) > 0) return;
    onToggle?.();
  }

  if (locked || readOnly) {
    return (
      <span
        title={locked ? lockedHint : placeholder}
        className={cn(OUTER, "bg-foreground/[0.04] ring-border/50", className)}
      >
        <span className={INNER}>
          <code
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground",
              placeholderClassName,
            )}
          >
            {placeholder}
          </code>
          {locked && (
            <Lock
              className="size-3.5 shrink-0 text-muted-foreground/60"
              aria-hidden
            />
          )}
        </span>
        {locked && <span className="sr-only">Secret value, hidden</span>}
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      aria-pressed={revealed}
      aria-label={revealed ? labels.hide : labels.reveal}
      // No `value` in the title while hidden either — the tooltip is a DOM
      // attribute, and the whole point is that the value is nowhere in the DOM
      // until revealed.
      title={revealed && value !== null ? value : "Click to reveal"}
      className={cn(
        OUTER,
        "group cursor-pointer text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        revealed
          ? "ring-border/40 hover:bg-foreground/[0.03]"
          : "bg-foreground/[0.06] ring-border/50 hover:bg-foreground/[0.09]",
        pending && "cursor-progress",
        className,
      )}
    >
      <span className={INNER}>
        {pending ? (
          <Loader2
            aria-hidden
            className="size-3.5 shrink-0 animate-spin text-muted-foreground/60"
          />
        ) : revealed ? (
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
        {revealed && value !== null ? (
          <code className="min-w-0 flex-1 select-text truncate font-mono text-xs text-foreground/90">
            {value}
          </code>
        ) : (
          // Placeholder ONLY. The real value is never rendered while hidden, so
          // nothing in this subtree — text or attribute — carries it.
          <code
            aria-hidden
            className={cn(
              "min-w-0 flex-1 select-none truncate font-mono text-xs text-muted-foreground",
              placeholderClassName,
            )}
          >
            {placeholder}
          </code>
        )}
      </span>
    </button>
  );
}
