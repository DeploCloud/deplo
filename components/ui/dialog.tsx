"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useNestedLayerDismissGuard } from "@/components/ui/use-nested-layer-dismiss-guard";
import { overlayAutoFocus } from "@/components/ui/overlay-autofocus";
import { AnimatedHeight } from "@/components/shared/animated-height";
import { Button } from "@/components/ui/button";
import { useSheetDrag } from "@/components/ui/use-sheet-drag";

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
    data-slot="sheet-scrim"
    className={cn(
      // pointer-events-auto: Radix sets pointer-events:none on <body> while a modal is open and the overlay would INHERIT it.
      // z-[45], never z-50: overlay and content are SEPARATE portals, so a close+reopen can append the
      // overlay after the content, and an equal z-index then paints the scrim over the dialog.
      "pointer-events-auto fixed inset-0 z-[45] bg-black/70 backdrop-blur-sm data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
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
    const sheet = useSheetDrag();
    return (
      <DialogPortal>
        <DialogOverlay className={overlayClassName} />
        <DialogPrimitive.Content
          data-slot="sheet"
          ref={(node) => {
            contentRef.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
          }}
          className={cn(
            "fixed top-[50%] left-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] grid-cols-[minmax(0,1fr)] gap-4 rounded-xl border border-border bg-background p-6 shadow-2xl duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            // Below md every dialog is a bottom sheet with a drag pill.
            "max-md:top-auto max-md:bottom-0 max-md:left-0 max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-t-3xl max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:bg-card max-md:px-6 max-md:pt-[30px] max-md:pb-[calc(env(safe-area-inset-bottom)+24px)] max-md:shadow-[0_-12px_40px_rgb(0_0_0/0.55)]",
            !selfManaged &&
              "max-h-[85dvh] grid-rows-[minmax(0,1fr)] max-md:max-h-[calc(100dvh-2.5rem)]",
            className,
          )}
          {...sheet.handlers}
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
          <div
            aria-hidden
            className="absolute inset-x-0 top-0 h-[30px] touch-none md:hidden"
          >
            <span className="mx-auto mt-2.5 block h-1 w-9 rounded-full bg-ring" />
          </div>
          {selfManaged ? (
            children
          ) : (
            // A modal never jumps: content that appears or loads grows it smoothly.
            <div className="focus-safe-scroll grid min-h-0 grid-cols-[minmax(0,1fr)] overflow-y-auto">
              <AnimatedHeight
                scroll={false}
                className="grid grid-cols-[minmax(0,1fr)] gap-4"
              >
                {children}
              </AnimatedHeight>
            </div>
          )}
          {!hideClose && (
            <DialogPrimitive.Close
              type="button"
              className="absolute top-4 right-4 cursor-pointer rounded-sm opacity-60 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:outline-none max-md:top-6 max-md:right-5 max-md:grid max-md:size-9 max-md:place-items-center max-md:rounded-full max-md:border max-md:border-border max-md:bg-accent max-md:opacity-100"
            >
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </DialogPrimitive.Close>
          )}
          {sheet.confirmDiscard && (
            <div
              role="alertdialog"
              aria-label="Discard changes?"
              className="absolute inset-x-0 bottom-0 z-10 flex flex-col gap-3 rounded-t-3xl border-t border-border bg-card px-6 pt-6 pb-[calc(env(safe-area-inset-bottom)+24px)] md:hidden"
            >
              <p className="text-lg font-semibold">Discard changes?</p>
              <p className="text-sm text-muted-foreground">
                What you typed here{" "}
                <strong className="font-medium text-foreground">
                  will be lost
                </strong>
                .
              </p>
              <div className="mt-1 flex justify-between gap-3">
                <Button variant="outline" onClick={sheet.keepEditing}>
                  Keep editing
                </Button>
                <Button variant="destructive" onClick={sheet.discard}>
                  Discard
                </Button>
              </div>
            </div>
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
    data-sheet-drag
    className={cn(
      "flex flex-col space-y-1.5 text-left max-md:touch-none max-md:pr-10",
      className,
    )}
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
        ? "justify-between max-sm:flex-row max-md:[&>*]:min-w-[110px]"
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
