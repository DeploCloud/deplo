"use client";

import * as React from "react";
import { Eye, EyeOff, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

// REVEAL_MASK - matches the server-side MASK for secrets in lib/data/env.ts / global-env.ts.
export const REVEAL_MASK = "••••••••••••";

const OUTER =
  "relative block h-7 w-full rounded-md align-middle ring-1 ring-inset";
const INNER = "absolute inset-0 flex items-center gap-1.5 px-2";

// RevealChip - one covered value with an eye toggle; `locked` never opens, it is a padlock and dots.
export function RevealChip({
  value = null,
  revealed = false,
  onToggle,
  placeholder = REVEAL_MASK,
  placeholderClassName,
  pending = false,
  locked = false,
  lockedHint = "Secret - hidden, and can never be read back.",
  readOnly = false,
  labels = { reveal: "Reveal value", hide: "Hide value" },
  className,
}: {
  value?: string | null;
  revealed?: boolean;
  onToggle?: () => void;
  placeholder?: string;
  placeholderClassName?: string;
  pending?: boolean;
  locked?: boolean;
  lockedHint?: string;
  readOnly?: boolean;
  labels?: { reveal: string; hide: string };
  className?: string;
}) {
  function handleClick() {
    // A drag to copy the value ends in a click; don't let that click slam the chip shut.
    if (revealed && (window.getSelection()?.toString().length ?? 0) > 0) return;
    onToggle?.();
  }

  if (locked || readOnly) {
    return (
      <span
        title={locked ? lockedHint : placeholder}
        className={cn(OUTER, "bg-surface ring-border/50", className)}
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
      // The value is nowhere in the DOM until revealed - the title attribute included.
      title={revealed && value !== null ? value : "Click to reveal"}
      className={cn(
        OUTER,
        "group cursor-pointer text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        revealed
          ? "ring-border/40 hover:bg-surface"
          : "bg-surface ring-border/50 hover:bg-surface",
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
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/90 select-text">
            {value}
          </code>
        ) : (
          <code
            aria-hidden
            className={cn(
              "min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground select-none",
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
