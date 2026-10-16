"use client";

import * as React from "react";
import {
  SlidingBackground,
  useSlidingRect,
} from "@/components/ui/sliding-underline";
import { cn } from "@/lib/utils";

export function SlidingButtonGroup({
  children,
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  const ref = React.useRef<HTMLDivElement>(null);
  const rect = useSlidingRect(
    ref,
    () =>
      ref.current?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? null,
    [],
    true,
  );
  return (
    <div
      ref={ref}
      role="group"
      className={cn(
        "relative isolate flex items-center gap-0.5 rounded-lg border border-border p-0.5 [&_button]:relative [&_button]:z-10",
        className,
      )}
      {...props}
    >
      <SlidingBackground rect={rect} className="bg-secondary" />
      {children}
    </div>
  );
}
