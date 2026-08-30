"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
import {
  useSlidingRect,
  SlidingUnderline,
} from "@/components/ui/sliding-underline";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex h-9 items-center justify-center gap-1 text-muted-foreground",
      className,
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

// Icon + label spacing, straight off `buttonVariants`: a trigger is a button with
// an icon in it, and every one of ours has an icon. Without this each call site
// re-invented the gap, or forgot it, and the glyph sat glued to the word.
const TRIGGER_ICON = "gap-2 [&_svg]:size-4 [&_svg]:shrink-0";

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex cursor-pointer items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-all hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-accent data-[state=active]:text-foreground",
      TRIGGER_ICON,
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-4 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

/**
 * Underline tab list for page sub-nav. The underline is a single element that
 * SLIDES between triggers, following whichever has `data-state="active"`.
 */
function UnderlineTabsList({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  const listRef =
    React.useRef<React.ElementRef<typeof TabsPrimitive.List>>(null);
  const rect = useSlidingRect(
    listRef,
    () =>
      listRef.current?.querySelector<HTMLElement>('[data-state="active"]') ??
      null,
    [],
    true,
  );
  return (
    <TabsPrimitive.List
      ref={listRef}
      className={cn(
        // Scrolls sideways instead of widening the page: a tab strip is the one row that
        // must keep every label on one line, and on a phone three of them already outgrow
        // the viewport.
        "relative scrollbar-none flex h-12 items-center gap-1 overflow-x-auto border-b border-border bg-transparent p-0",
        className,
      )}
      {...props}
    >
      {children}
      <SlidingUnderline rect={rect} />
    </TabsPrimitive.List>
  );
}
UnderlineTabsList.displayName = "UnderlineTabsList";

const UnderlineTabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "inline-flex h-12 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none data-[state=active]:text-foreground",
      TRIGGER_ICON,
      className,
    )}
    {...props}
  />
));
UnderlineTabsTrigger.displayName = "UnderlineTabsTrigger";

export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
};
