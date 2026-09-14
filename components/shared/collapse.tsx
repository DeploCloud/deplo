"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

// Collapse is a drawer that eases open and shut instead of snapping.
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
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
    >
      {/* `overflow-hidden` is what lets the row shrink below its content. */}
      <div className="overflow-hidden">
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}
