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

/** The control inside a `Field`: the group draws the focus ring, not the input. */
export const fieldControl = "focus-visible:ring-0 focus-visible:ring-offset-0";

/**
 * A field's error, drawn as that field's own border growing downward rather
 * than as a card under it.
 */
function FieldError({ children }: { children?: string | null }) {
  return (
    <Collapse open={Boolean(children)}>
      <p className="rounded-b-md border border-t-0 border-destructive/40 bg-destructive/10 px-3 pt-1.5 pb-2 text-xs text-destructive">
        {children}
      </p>
    </Collapse>
  );
}

/**
 * A control and the error that grows out of its border. The GROUP owns the
 * focus ring: left on the input, the ring would close above the error and cut
 * the field in two. Give the control `fieldControl` and, when invalid,
 * `invalidField`.
 */
export function Field({
  error,
  className,
  children,
}: {
  error?: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-md ring-offset-background focus-within:ring-2 focus-within:ring-offset-1",
        error ? "focus-within:ring-destructive/50" : "focus-within:ring-ring",
        className,
      )}
    >
      {children}
      <FieldError>{error}</FieldError>
    </div>
  );
}
