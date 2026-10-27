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
export function DetailRow({
  value,
  title,
  meta,
  forceMount,
  className,
  children,
}: {
  value: string;
  title: React.ReactNode;
  meta?: React.ReactNode;
  forceMount?: true;
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
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
          {title}
        </AccordionPrimitive.Trigger>
        {meta && (
          <span className="pointer-events-none flex items-center gap-3 text-sm [&_button]:pointer-events-auto [&_button]:relative">
            {meta}
          </span>
        )}
      </AccordionPrimitive.Header>
      <AccordionPrimitive.Content
        forceMount={forceMount}
        className={cn(
          "border-t border-border data-[state=closed]:hidden",
          className,
        )}
      >
        {children}
      </AccordionPrimitive.Content>
    </AccordionPrimitive.Item>
  );
}
