"use client";

import * as React from "react";
import * as AccordionPrimitive from "@radix-ui/react-accordion";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export function DetailRows({
  value,
  onValueChange,
  className,
  children,
}: {
  value?: string[];
  onValueChange?: (value: string[]) => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AccordionPrimitive.Root
      type="multiple"
      value={value}
      onValueChange={onValueChange}
      className={className}
    >
      {children}
    </AccordionPrimitive.Root>
  );
}

// The whole row opens it; a button inside `meta` stays its own click.
// Always mounted, so a closed section keeps its state (a live log keeps polling).
export function DetailRow({
  value,
  title,
  meta,
  className,
  children,
}: {
  value: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <AccordionPrimitive.Item
      value={value}
      className="border-b border-border last:border-b-0"
    >
      <AccordionPrimitive.Header className="relative flex items-center gap-3 px-5 py-4 hover:bg-surface">
        <AccordionPrimitive.Trigger className="group flex flex-1 cursor-pointer items-center gap-3 text-left text-sm font-medium outline-none after:absolute after:inset-0 focus-visible:after:ring-2 focus-visible:after:ring-ring focus-visible:after:ring-inset">
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out group-data-[state=open]:rotate-90 motion-reduce:transition-none" />
          {title}
        </AccordionPrimitive.Trigger>
        {meta && (
          <span className="pointer-events-none flex items-center gap-3 text-sm [&_button]:pointer-events-auto [&_button]:relative">
            {meta}
          </span>
        )}
      </AccordionPrimitive.Header>
      {/* Radix zeroes the Content's own transition to measure it, so the motion lives one level in. */}
      <AccordionPrimitive.Content forceMount className="group/row">
        <div className="grid transition-[grid-template-rows,opacity,visibility] duration-200 ease-out group-data-[state=closed]/row:invisible group-data-[state=closed]/row:grid-rows-[0fr] group-data-[state=closed]/row:opacity-0 group-data-[state=open]/row:grid-rows-[1fr] motion-reduce:transition-none">
          <div className="min-h-0 overflow-hidden">
            <div className={cn("border-t border-border", className)}>
              {children}
            </div>
          </div>
        </div>
      </AccordionPrimitive.Content>
    </AccordionPrimitive.Item>
  );
}
