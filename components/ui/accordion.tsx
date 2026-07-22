"use client";

import * as React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

const Accordion = AccordionPrimitive.Root;

const AccordionItem = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Item>
>(({ className, ...props }, ref) => (
  <AccordionPrimitive.Item
    ref={ref}
    className={cn("border-b border-border", className)}
    {...props}
  />
));
AccordionItem.displayName = "AccordionItem";

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <AccordionPrimitive.Header className="flex">
    <AccordionPrimitive.Trigger
      ref={ref}
      className={cn(
        "flex flex-1 cursor-pointer items-center justify-between py-4 text-sm font-medium transition-all hover:underline [&[data-state=open]>svg]:rotate-180",
        className
      )}
      {...props}
    >
      {children}
      <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-200" />
    </AccordionPrimitive.Trigger>
  </AccordionPrimitive.Header>
));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, onAnimationStart, onAnimationEnd, ...props }, ref) => {
  // `overflow: hidden` is what turns the open/close height animation into a
  // slide instead of a spill — but it clips ANYTHING a child paints outside its
  // own box, and a focus ring is exactly that. The panel has no side padding, so
  // a focused full-width field inside it came out with its ring sliced off left
  // and right (the "half border" on the domain dialog's advanced settings).
  //
  // The clip is only needed WHILE the height is animating, so release it the
  // moment the panel settles. With animations off (reduced motion) no animation
  // event ever fires and it simply never clips — which is correct, there is no
  // slide to contain.
  const [animating, setAnimating] = React.useState(false);
  return (
    <AccordionPrimitive.Content
      ref={ref}
      // Guarded on the target: `animate-in` children bubble their own animation
      // events through here, and they must not pin the panel shut.
      onAnimationStart={(event) => {
        if (event.target === event.currentTarget) setAnimating(true);
        onAnimationStart?.(event);
      }}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setAnimating(false);
        onAnimationEnd?.(event);
      }}
      className={cn(
        "text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down",
        // Closed (or mid-animation) it must clip; open and settled it must not.
        animating ? "overflow-hidden" : "data-[state=closed]:overflow-hidden",
      )}
      {...props}
    >
      <div className={cn("pb-4 pt-0 text-muted-foreground", className)}>
        {children}
      </div>
    </AccordionPrimitive.Content>
  );
});
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

export { Accordion, AccordionItem, AccordionTrigger, AccordionContent };
