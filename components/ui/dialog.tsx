"use client";

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
      // pointer-events-auto: Radix sets pointer-events:none on <body> while a modal is open and the overlay would INHERIT it.
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
    selfManaged?: boolean;
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
            "fixed top-[50%] left-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] grid-cols-[minmax(0,1fr)] gap-4 rounded-xl border border-border bg-background p-6 shadow-2xl duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            !selfManaged && "max-h-[85dvh] grid-rows-[minmax(0,1fr)]",
            className,
          )}
          onInteractOutside={(event) => {
            if (nestedLayerJustDismissed()) {
              event.preventDefault();
              return;
            }
            onInteractOutside?.(event);
          }}
          onOpenAutoFocus={(event) => {
            onOpenAutoFocus?.(event);
            overlayAutoFocus(event, contentRef.current);
          }}
          {...props}
        >
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

// A two-control footer splits, secondary far left; toArray means an absent {cond && <Button/>} does not count, and sm:justify-end opts out.
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
    className={cn(
      "text-sm leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground",
      className,
    )}
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
