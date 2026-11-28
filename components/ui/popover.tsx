"use client";

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";
import { overlayAutoFocus } from "@/components/ui/overlay-autofocus";
import { MENU_MOTION, MENU_SURFACE } from "@/components/ui/menu-styles";

const Popover = PopoverPrimitive.Root;
const PopoverTrigger = PopoverPrimitive.Trigger;
const PopoverAnchor = PopoverPrimitive.Anchor;

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>
>(
  (
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
            "z-50 w-72 origin-(--radix-popover-content-transform-origin) outline-none",
            MENU_MOTION,
            MENU_SURFACE,
            "p-4",
            className,
          )}
          onOpenAutoFocus={(event) => {
            onOpenAutoFocus?.(event);
            overlayAutoFocus(event, contentRef.current);
          }}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  },
);
PopoverContent.displayName = PopoverPrimitive.Content.displayName;

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
