"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * A drawer that eases open and shut instead of snapping. A grid row going
 * `0fr → 1fr` is what animates a height nobody measured; `inert` keeps the shut
 * content out of the tab order.
 */
export function Collapse({
  open,
  className,
  children,
}: {
  open: boolean;
  /** Layout of the content box - its own border, padding and spacing. */
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
      {/* `overflow-hidden` both clips the closed drawer and is what lets the row
          shrink below its content in the first place. */}
      <div className="overflow-hidden">
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}
