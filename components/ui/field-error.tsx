"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Content that eases open and shut instead of appearing at full height. Pure
 * CSS grid rows, so it nests and needs no measuring.
 */
export function Collapse({
  open,
  className,
  children,
}: {
  open: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div className="overflow-hidden">{children}</div>
    </div>
  );
}

/** The className the field above a `FieldError` wears while it is invalid. */
export const invalidField = "rounded-b-none border-destructive/40";

/**
 * A field's error, drawn as that field's own border growing downward rather
 * than as a card under it. Pair it with `invalidField` on the control.
 */
export function FieldError({ children }: { children?: string | null }) {
  return (
    <Collapse open={Boolean(children)}>
      <p className="rounded-b-md border border-t-0 border-destructive/40 bg-destructive/10 px-3 pt-1.5 pb-2 text-xs text-destructive">
        {children}
      </p>
    </Collapse>
  );
}
