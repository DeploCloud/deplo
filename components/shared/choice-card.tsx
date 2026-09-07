"use client";

import * as React from "react";
import { ArrowRight, Check } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * One option as a big, clickable card - icon, title, one-line blurb, tick.
 */
export function ChoiceCard({
  title,
  blurb,
  icon: Icon,
  selected = false,
  disabled = false,
  disabledNote,
  multi = false,
  arrow = false,
  onSelect,
}: {
  title: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Absent on a card that ACTS: it moves on, so it holds nothing to show. */
  selected?: boolean;
  disabled?: boolean;
  /** Shown instead of the blurb while disabled - say WHY, not that it is off. */
  disabledNote?: string;
  multi?: boolean;
  /** The card IS the answer: picking it moves on, so it points instead of ticking. */
  arrow?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      // With an arrow the card is an action, not a choice held on screen: it
      // moves on, so there is no checked state to announce.
      role={arrow ? undefined : multi ? "checkbox" : "radio"}
      aria-checked={arrow ? undefined : selected}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "group flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        selected
          ? "border-primary bg-primary-wash ring-1 ring-primary/60"
          : // Opaque: these cards also sit on the dotted ground, which must not
            // show through them.
            "border-border bg-background hover:border-foreground/20 hover:bg-surface",
      )}
    >
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors",
          selected
            ? "border-primary/40 bg-background text-primary"
            : "border-border bg-surface-strong text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
          {disabled && disabledNote ? disabledNote : blurb}
        </span>
      </span>
      {arrow ? (
        <ArrowRight className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-1 group-hover:text-foreground motion-reduce:transition-none" />
      ) : (
        <CheckMark selected={selected} className="mt-0.5" />
      )}
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
