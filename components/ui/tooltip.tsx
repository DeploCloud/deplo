"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";
import { isOverlayAutoFocusing } from "@/components/ui/overlay-autofocus";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;

/**
 * Keep a tooltip SHUT unless the user actually asked for it.
 *
 * Radix opens a tooltip on *any* focus of the trigger
 * (`onFocus: composeEventHandlers(props.onFocus, () => context.onOpen())`), and an
 * overlay focuses its first tabbable element as it opens — next to a field label
 * that element is the little info button, so the dialog came up with a tooltip
 * already floating over it.
 *
 * `:focus-visible` alone does NOT settle it, which is the trap: Chrome carries
 * focus-visible over to whatever is focused programmatically next, so a dialog
 * opened from a ⋯ menu (the menu item was focus-visible) matched it and opened
 * the tooltip anyway. Hence {@link isOverlayAutoFocusing}, which knows what the
 * heuristic can't: that this focus is the surface's doing, not the user's.
 *
 * `preventDefault()` is Radix's own escape hatch: `composeEventHandlers` skips
 * the primitive's handler on a default-prevented event. Focus itself is NOT
 * cancelled (a focus event isn't cancelable) — only Radix's reaction to it. A
 * real keyboard focus (Tab onto the trigger) still shows the hint.
 */
function keyboardOnlyTooltipFocus(event: React.FocusEvent<HTMLElement>) {
  if (isOverlayAutoFocusing() || !event.currentTarget.matches(":focus-visible"))
    event.preventDefault();
}

/**
 * The trigger EVERY tooltip goes through, so the guard above is never something
 * a call site has to remember — a raw `TooltipPrimitive.Trigger` would open on a
 * dialog's auto-focus again. A caller's own `onFocus` runs first and can opt out
 * by preventing default itself.
 */
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
        "z-50 overflow-hidden rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 max-w-xs",
        className
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
 * A submenu trigger with a tooltip that steps aside for the submenu. A submenu
 * opens on the same hover gesture that would show the trigger's tooltip, so the
 * two would otherwise overlap. Here the tooltip is controlled and forced shut
 * while the submenu is open (`subOpen`), then behaves normally again once it
 * closes.
 *
 * The menu primitives are passed in (`Sub`/`SubTrigger`/`SubContent`) so the
 * same component works for both context menus and dropdown menus. `trigger` is
 * the SubTrigger's inner content; `children` are the submenu's items.
 */
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
