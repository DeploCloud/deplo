"use client";

import * as React from "react";
import * as LabelPrimitive from "@radix-ui/react-label";
import { cn } from "@/lib/utils";

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn(
      // `block` is load-bearing: Tailwind v4's `space-y-*` puts its gap on the
      // FIRST child as `margin-block-end` (v3 used `margin-top` on the next
      // child). A <label> is `display:inline` by default and inline boxes ignore
      // vertical margins, so every `space-y` field group silently lost the gap
      // between its label and control. Making the label a block box lets that
      // margin apply again. Usages that pass their own `flex`/`inline-flex`
      // (e.g. a label with an inline icon) still win via tailwind-merge.
      "block text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
      className
    )}
    {...props}
  />
));
Label.displayName = LabelPrimitive.Root.displayName;

export { Label };
