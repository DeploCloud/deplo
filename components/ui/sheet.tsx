"use client";

import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { cva, type VariantProps } from "class-variance-authority";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNestedLayerDismissGuard } from "@/components/ui/use-nested-layer-dismiss-guard";
import { overlayAutoFocus } from "@/components/ui/overlay-autofocus";
import { DiscardPrompt, SheetHandle } from "@/components/ui/sheet-chrome";
import { useSheetDrag } from "@/components/ui/use-sheet-drag";

const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;
const SheetPortal = SheetPrimitive.Portal;

const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Overlay
    data-slot="sheet-scrim"
    className={cn(
      // z-[45], never z-50: overlay and content are SEPARATE portals, so a close+reopen can append the
      // overlay after the content, and an equal z-index then paints the scrim over the sheet.
      "pointer-events-auto fixed inset-0 z-[45] bg-black/70 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
    ref={ref}
  />
));
SheetOverlay.displayName = SheetPrimitive.Overlay.displayName;

const sheetVariants = cva(
  [
    "fixed z-50 gap-4 bg-sidebar p-0 shadow-lg transition ease-in-out data-[state=closed]:animate-out data-[state=closed]:duration-300 data-[state=open]:animate-in data-[state=open]:duration-300",
    // Below md every side is a bottom sheet, like a dialog.
    "max-md:inset-x-0 max-md:top-auto max-md:bottom-0 max-md:h-auto max-md:w-full max-md:max-w-none max-md:rounded-t-3xl max-md:border-x-0 max-md:border-t max-md:border-b-0 max-md:bg-card max-md:pt-[30px] max-md:pb-[env(safe-area-inset-bottom)] max-md:shadow-[0_-12px_40px_rgb(0_0_0/0.55)]",
  ],
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-72 overflow-y-auto border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left",
        right:
          "inset-y-0 right-0 h-full w-72 overflow-y-auto border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
      },
    },
    defaultVariants: { side: "left" },
  },
);

interface SheetContentProps
  extends
    React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content>,
    VariantProps<typeof sheetVariants> {}

const SheetContent = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Content>,
  SheetContentProps
>(
  (
    {
      side = "left",
      className,
      children,
      onInteractOutside,
      onOpenAutoFocus,
      ...props
    },
    ref,
  ) => {
    const nestedLayerJustDismissed = useNestedLayerDismissGuard();
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    const sheet = useSheetDrag();
    const sheetRef = sheet.ref;
    const setRefs = React.useCallback(
      (node: HTMLDivElement | null) => {
        contentRef.current = node;
        sheetRef(node);
        if (typeof ref === "function") ref(node);
        else if (ref) ref.current = node;
      },
      [ref, sheetRef],
    );
    return (
      <SheetPortal>
        <SheetOverlay />
        <SheetPrimitive.Content
          data-slot="sheet"
          ref={setRefs}
          className={cn(sheetVariants({ side }), className)}
          {...sheet.handlers}
          onInteractOutside={(event) => {
            if (nestedLayerJustDismissed()) {
              event.preventDefault();
              return;
            }
            onInteractOutside?.(event);
            if (!event.defaultPrevented) sheet.guardOutside(event);
          }}
          onOpenAutoFocus={(event) => {
            onOpenAutoFocus?.(event);
            overlayAutoFocus(event, contentRef.current);
          }}
          {...props}
        >
          <SheetHandle />
          <SheetPrimitive.Close className="absolute top-4 right-4 cursor-pointer rounded-sm opacity-70 transition-opacity hover:opacity-100 focus:outline-none max-md:sr-only">
            <X className="size-5" />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
          {children}
          {sheet.confirmDiscard && (
            <DiscardPrompt
              onKeep={sheet.keepEditing}
              onDiscard={sheet.discard}
            />
          )}
        </SheetPrimitive.Content>
      </SheetPortal>
    );
  },
);
SheetContent.displayName = SheetPrimitive.Content.displayName;

const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Title
    ref={ref}
    className={cn(
      "text-base font-semibold text-foreground lg:text-lg",
      className,
    )}
    {...props}
  />
));
SheetTitle.displayName = SheetPrimitive.Title.displayName;

const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(({ className, ...props }, ref) => (
  <SheetPrimitive.Description
    ref={ref}
    className={cn(
      "text-sm text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground",
      className,
    )}
    {...props}
  />
));
SheetDescription.displayName = SheetPrimitive.Description.displayName;

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetTitle,
  SheetDescription,
};
