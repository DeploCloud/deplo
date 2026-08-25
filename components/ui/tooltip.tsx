"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";
import { isOverlayAutoFocusing } from "@/components/ui/overlay-autofocus";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;

/**
 * Keep a tooltip SHUT unless the user asked for it. Radix opens on ANY focus of
 * the trigger, and `:focus-visible` does not settle it - Chrome carries it over
 * to whatever is focused programmatically next. Hence {@link isOverlayAutoFocusing}.
 * `preventDefault()` is Radix's escape hatch; focus itself is not cancelled. */
function keyboardOnlyTooltipFocus(event: React.FocusEvent<HTMLElement>) {
  if (isOverlayAutoFocusing() || !event.currentTarget.matches(":focus-visible"))
    event.preventDefault();
}

/**
 * The trigger EVERY tooltip goes through, so the guard above is never something
 * a call site has to remember. A caller's own `onFocus` runs first and can opt
 * out by preventing default itself. */
const TooltipTrigger = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Trigger>
>(({ onFocus, ...props }, ref) => (
  <TooltipPrimitive.Trigger
    ref={ref}
    onFocus={(event) => {
      onFocus?.(event);
      if (!event.defaultPrevented) keyboardOnlyTooltipFocus(event);
    }}
    {...props}
  />
));
TooltipTrigger.displayName = TooltipPrimitive.Trigger.displayName;

const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-xs animate-in overflow-hidden rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

/** Convenience wrapper: <InfoTip>text</InfoTip> around a trigger. */
function SimpleTooltip({
  content,
  children,
  side = "top",
}: {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}

/**
 * A submenu trigger whose tooltip steps aside for the submenu - both open on the
 * same hover gesture. The menu primitives are passed in, so this works for both
 * context and dropdown menus. `trigger` is the SubTrigger's inner content. */
function MenuSubTooltip({
  Sub,
  SubTrigger,
  SubContent,
  content,
  trigger,
  children,
  side = "left",
  subTriggerClassName,
  subContentClassName,
}: {
  Sub: React.ElementType;
  SubTrigger: React.ElementType;
  SubContent: React.ElementType;
  content: React.ReactNode;
  trigger: React.ReactNode;
  children: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  subTriggerClassName?: string;
  subContentClassName?: string;
}) {
  const [subOpen, setSubOpen] = React.useState(false);
  const [tipOpen, setTipOpen] = React.useState(false);
  return (
    <Sub onOpenChange={setSubOpen}>
      <Tooltip open={tipOpen && !subOpen} onOpenChange={setTipOpen}>
        <TooltipTrigger asChild>
          <SubTrigger className={subTriggerClassName}>{trigger}</SubTrigger>
        </TooltipTrigger>
        <TooltipContent side={side}>{content}</TooltipContent>
      </Tooltip>
      <SubContent className={subContentClassName}>{children}</SubContent>
    </Sub>
  );
}

export {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
  SimpleTooltip,
  MenuSubTooltip,
};
