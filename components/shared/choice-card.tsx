"use client";

import * as React from "react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One option as a big, clickable card — icon, title, one-line blurb, tick.
 *
 * The shape a wizard uses when the choice IS the step: a radio group of two or
 * three cards reads as a decision, where the same choice as a `<select>` reads as
 * a setting you are expected to already understand.
 *
 * `multi` decides the semantics, and nothing else changes: `false` (default) is
 * a radio — one of the set — and `true` is a checkbox, several at once.
 */
export function ChoiceCard({
  title,
  blurb,
  icon: Icon,
  selected,
  disabled = false,
  disabledNote,
  multi = false,
  onSelect,
}: {
  title: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  selected: boolean;
  disabled?: boolean;
  /** Shown instead of the blurb while disabled — say WHY, not that it is off. */
  disabledNote?: string;
  multi?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role={multi ? "checkbox" : "radio"}
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-primary bg-primary/[0.06] ring-1 ring-primary/60"
          : "border-border hover:border-foreground/20 hover:bg-muted/40",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors",
          selected
            ? "border-primary/40 bg-background text-primary"
            : "border-border bg-muted/50 text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
          {disabled && disabledNote ? disabledNote : blurb}
        </span>
      </span>
      <CheckMark selected={selected} className="mt-0.5" />
    </button>
  );
}

/** The square tick of a card that is itself the control. */
export function CheckMark({
  selected,
  className,
}: {
  selected: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/40",
        className,
      )}
    >
      {selected && <Check className="size-3" />}
    </span>
  );
}
