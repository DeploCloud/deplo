"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNestedLayerDismissGuard } from "@/components/ui/use-nested-layer-dismiss-guard";
import { overlayAutoFocus } from "@/components/ui/overlay-autofocus";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogPortal = DialogPrimitive.Portal;
const DialogClose = DialogPrimitive.Close;

const DialogOverlay = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Overlay>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Overlay
    ref={ref}
    className={cn(
      // pointer-events-auto is load-bearing: while a modal is open Radix sets
      // `pointer-events: none` on <body>, which the overlay would otherwise INHERIT -
      // letting clicks fall through to background elements that opt back in with
      "pointer-events-auto fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
      className,
    )}
    {...props}
  />
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;

const DialogContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    hideClose?: boolean;
    /**
     * This dialog owns its own height and scrolling - skip the bounded shell.
     * For the wizards, whose `grid-rows` addresses the content's direct
     * children, and the backup wizard, whose animated height must overflow.
     */
    selfManaged?: boolean;
    /** Extra classes for the backdrop - a heavier blur, say. */
    overlayClassName?: string;
  }
>(
  (
    {
      className,
      children,
      hideClose,
      selfManaged,
      overlayClassName,
      onInteractOutside,
      onOpenAutoFocus,
      ...props
    },
    ref,
  ) => {
    const nestedLayerJustDismissed = useNestedLayerDismissGuard();
    const contentRef = React.useRef<HTMLDivElement | null>(null);
    return (
      <DialogPortal>
        <DialogOverlay className={overlayClassName} />
        <DialogPrimitive.Content
          ref={(node) => {
            contentRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          className={cn(
            // grid-cols-[minmax(0,1fr)]: a grid item's automatic minimum size is its
            // min-content width, so one wide child (an unwrapped <pre>, a long URL) would
            // stretch the column past max-w-* and push the content out of the modal instead of
            "fixed top-[50%] left-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] grid-cols-[minmax(0,1fr)] gap-4 rounded-xl border border-border bg-background p-6 shadow-2xl duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            // Centred with a translate and nothing bounding it, a dialog taller than the window
            // used to run off BOTH edges at once - and Radix scroll-locks the page behind it,
            // so neither end could be reached.
            !selfManaged && "max-h-[85dvh] grid-rows-[minmax(0,1fr)]",
            className,
          )}
          onInteractOutside={(event) => {
            // Swallow the outside-dismiss when this gesture just closed a nested
            // popper (Select/menu/popover); otherwise defer to the caller.
            if (nestedLayerJustDismissed()) {
              event.preventDefault();
              return;
            }
            onInteractOutside?.(event);
          }}
          // Every modal in the app is this component, so none of them can open with
          // a focus ring on an info icon or a tooltip already showing.
          onOpenAutoFocus={(event) => {
            onOpenAutoFocus?.(event);
            overlayAutoFocus(event, contentRef.current);
          }}
          {...props}
        >
          {/* The scroll lives on a WRAPPER: the close button is absolutely positioned
          and would scroll away with the body. `focus-safe-scroll` stops a
          focused full-width field having its ring sliced by the clip. */}
          {selfManaged ? (
            children
          ) : (
            <div className="focus-safe-scroll grid min-h-0 grid-cols-[minmax(0,1fr)] gap-4 overflow-y-auto">
              {children}
            </div>
          )}
          {!hideClose && (
            <DialogPrimitive.Close
              type="button"
              className="absolute top-4 right-4 cursor-pointer rounded-sm opacity-60 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-none"
            >
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
        </DialogPrimitive.Content>
      </DialogPortal>
    );
  },
);
DialogContent.displayName = DialogPrimitive.Content.displayName;

const DialogHeader = ({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn("flex flex-col space-y-1.5 text-left", className)}
    {...props}
  />
);
DialogHeader.displayName = "DialogHeader";

/**
 * A footer of exactly TWO controls is the one-primary-one-secondary shape, and
 * there the secondary (Cancel) sits at the far LEFT, apart from the action it
 * is not. Anything else - a third button, a hint beside the buttons - keeps
 * them together on the right, where a row of peers belongs.
 *
 * Counted with `toArray`, which drops the null a `{cond && <Button/>}` leaves
 * behind, so a conditional button that is absent does not split the row.
 * A caller that needs the other shape passes `sm:justify-end` and wins.
 */
const DialogFooter = ({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) => (
  <div
    className={cn(
      "flex flex-col-reverse gap-2 sm:flex-row",
      React.Children.toArray(children).length === 2
        ? "sm:justify-between"
        : "sm:justify-end",
      className,
    )}
    {...props}
  >
    {children}
  </div>
);
DialogFooter.displayName = "DialogFooter";

const DialogTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn(
      "text-lg leading-snug font-semibold tracking-tight",
      className,
    )}
    {...props}
  />
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;

const DialogDescription = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn("text-sm leading-relaxed text-muted-foreground", className)}
    {...props}
  />
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;

export {
  Dialog,
  DialogPortal,
  DialogOverlay,
  DialogClose,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
