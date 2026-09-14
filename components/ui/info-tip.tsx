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
import { DocsLink } from "@/components/ui/docs-link";
import type { DocsTopic } from "@/lib/docs";

type Side = "top" | "right" | "bottom" | "left";

// InfoTip is the icon beside a label: a `type="button"` so it never submits, and interactive content so a click inside a `<label>` does not forward to the control.
export function InfoTip({
  content,
  docs,
  docsLabel,
  side = "top",
  className,
  label = "More information",
}: {
  content: React.ReactNode;
  // Radix keeps the tooltip open while the pointer travels into it, so this link is clickable.
  docs?: DocsTopic;
  docsLabel?: string;
  side?: Side;
  className?: string;
  label?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          // Hint-only: `DialogContent` skips it when picking what to focus, since landing on an info icon gives a focus ring on something the user can't act on.
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
        {docs && (
          <DocsLink
            topic={docs}
            label={docsLabel}
            className="mt-1.5 block w-fit"
          />
        )}
      </TooltipContent>
    </Tooltip>
  );
}

// FieldLabel is a drop-in `<Label>` with an optional trailing InfoTip: pass `info` and it renders one, omit it and this is just a Label.
export function FieldLabel({
  children,
  info,
  docs,
  docsLabel,
  infoSide,
  infoLabel,
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof Label> & {
  info?: React.ReactNode;
  docs?: DocsTopic;
  docsLabel?: string;
  infoSide?: Side;
  infoLabel?: string;
}) {
  return (
    // `w-fit` so the label and its info trigger hug their content instead of stretching the full column width.
    <Label
      className={cn("flex w-fit items-center gap-1.5", className)}
      {...props}
    >
      {children}
      {info != null && (
        <InfoTip
          content={info}
          docs={docs}
          docsLabel={docsLabel}
          side={infoSide}
          label={infoLabel}
        />
      )}
    </Label>
  );
}
