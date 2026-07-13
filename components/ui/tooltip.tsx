"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

const TooltipProvider = TooltipPrimitive.Provider;
const Tooltip = TooltipPrimitive.Root;
const TooltipTrigger = TooltipPrimitive.Trigger;

/**
 * Keep a tooltip SHUT when its trigger is focused by anything but the keyboard.
 *
 * Radix opens a tooltip on *any* focus of the trigger
 * (`onFocus: composeEventHandlers(props.onFocus, () => context.onOpen())`), and a
 * Dialog focuses its first tabbable element as it opens. Next to a field label
 * that element is the little info button — so the dialog came up with its tooltip
 * already open, before the user had done anything.
 *
 * `preventDefault()` is Radix's own escape hatch: `composeEventHandlers` skips
 * the primitive's handler on a default-prevented event. Focus itself is NOT
 * cancelled (a focus event isn't cancelable) — only Radix's reaction to it. A
 * real keyboard focus still matches `:focus-visible` and still shows the hint.
 *
 * Pass it as `onFocus` on the TRIGGER (it is the "original" handler Radix
 * composes with), never on the child element.
 */
export function keyboardOnlyTooltipFocus(event: React.FocusEvent<HTMLElement>) {
  if (!event.currentTarget.matches(":focus-visible")) event.preventDefault();
}

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
      <TooltipTrigger asChild onFocus={keyboardOnlyTooltipFocus}>
        {children}
      </TooltipTrigger>
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
