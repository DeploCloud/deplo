"use client";

import * as React from "react";
import { Info } from "lucide-react";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type Side = "top" | "right" | "bottom" | "left";

/**
 * The "info" icon next to a label that carries the explanation the name cannot.
 * A `type="button"`, so it never submits the form, and interactive content, so a
 * click inside a `<label>` does not forward to the labelled control.
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
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          // Hint-only: `DialogContent` skips it when a dialog picks what to focus
          // on open, because landing on an info icon gives the user a focus ring
          // on something they can't act on (and used to pop the tooltip open).
          data-hint-trigger=""
          className={cn(
            "inline-flex size-3.5 shrink-0 cursor-help items-center justify-center rounded-full text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
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
 * A field label with an optional trailing info icon. Drop-in for `<Label>`: pass
 * `info` and it renders an {@link InfoTip}, omit it and this is just a Label.
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
    // instead of stretching the full column width.
    <Label
      className={cn("flex w-fit items-center gap-1.5", className)}
      {...props}
    >
      {children}
      {info != null && (
        <InfoTip content={info} side={infoSide} label={infoLabel} />
      )}
    </Label>
  );
}
