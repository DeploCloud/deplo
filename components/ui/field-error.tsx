"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

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

export const invalidField = "rounded-b-none border-destructive/40";

export const fieldControl = "focus-visible:ring-0 focus-visible:ring-offset-0";

function FieldError({ children }: { children?: string | null }) {
  return (
    <Collapse open={Boolean(children)}>
      <p className="rounded-b-md border border-t-0 border-destructive/40 bg-destructive-wash-strong px-3 pt-1.5 pb-2 text-xs text-destructive">
        {children}
      </p>
    </Collapse>
  );
}

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
