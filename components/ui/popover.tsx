"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";
import { overlayAutoFocus } from "@/components/ui/overlay-autofocus";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>((
  { className, align = "center", sideOffset = 4, onOpenAutoFocus, ...props },
  ref,
) => {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  return (
  <PopoverPrimitive.Portal>
    <PopoverPrimitive.Content
      ref={(node) => {
        contentRef.current = node;
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      }}
      align={align}
      sideOffset={sideOffset}
      className={cn(
        "z-50 w-72 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-lg outline-none animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
        className
      )}
      // A popover focuses itself open exactly like a dialog does, so it gets the
      // same treatment: no focus ring on a hint, no tooltip opening by itself.
      onOpenAutoFocus={(event) => {
        onOpenAutoFocus?.(event);
        overlayAutoFocus(event, contentRef.current);
      }}
      {...props}
    />
  </PopoverPrimitive.Portal>
  );
});
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
