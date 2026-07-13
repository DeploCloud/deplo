"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  keyboardOnlyTooltipFocus,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Side = "top" | "right" | "bottom" | "left";

/**
 * A small "info" icon that reveals an explanatory tooltip on hover/focus. It
 * sits next to a field label, toggle title or section header to carry the longer
 * explanation that doesn't fit in the name itself — the discoverable "why/how"
 * that a label alone can't convey.
 *
 * Renders as a `type="button"` so it never submits the surrounding form, and is
 * keyboard-focusable so the hint is reachable without a pointer. Because it is
 * interactive content, a click on it inside a `<label>` does NOT forward to the
 * labelled control (per the HTML spec), so it's safe to nest in a `<Label>`.
 */
export function InfoTip({
  content,
  side = "top",
  className,
  label = "More information",
}: {
  content: React.ReactNode;
  side?: Side;
  className?: string;
  /** Accessible name for the trigger, announced by screen readers. */
  label?: string;
}) {
  return (
    <Tooltip>
      {/* Shut on open: a Dialog focuses its first tabbable element, and next to a
          field label that is this button — see `keyboardOnlyTooltipFocus`. */}
      <TooltipTrigger asChild onFocus={keyboardOnlyTooltipFocus}>
        <button
          type="button"
          aria-label={label}
          className={cn(
            "inline-flex size-3.5 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground/70 outline-none transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <Info className="size-3.5" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs leading-relaxed">
        {content}
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * A field label with an optional trailing info icon. Drop-in replacement for
 * `<Label>` where the field needs more explanation than its name conveys: pass
 * the explanation as `info` and it renders an {@link InfoTip}; omit it and this
 * is just a `<Label>` laid out as a flex row (so a leading icon still aligns).
 */
export function FieldLabel({
  children,
  info,
  infoSide,
  infoLabel,
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof Label> & {
  info?: React.ReactNode;
  infoSide?: Side;
  infoLabel?: string;
}) {
  return (
    // `w-fit` so the label — and the info trigger it carries — hug their content
    // instead of stretching the full column width. A stretched label would give
    // the hover/click target (and the tooltip's anchor) a misleading width; the
    // tooltip and its container should span only the title + icon.
    <Label className={cn("flex w-fit items-center gap-1.5", className)} {...props}>
      {children}
      {info != null && <InfoTip content={info} side={infoSide} label={infoLabel} />}
    </Label>
  );
}
