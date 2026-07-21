"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { useInitialCaretAtEnd } from "@/components/ui/use-initial-caret-at-end";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  // Opened focused on a prefilled field, the caret belongs AFTER the value —
  // a textarea gets this wrong on its own, every time.
  const caretRef = useInitialCaretAtEnd<HTMLTextAreaElement>(ref);
  return (
    <textarea
      className={cn(
        "flex min-h-[80px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 font-mono",
        className
      )}
      ref={caretRef}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
