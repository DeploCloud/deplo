"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";
import {
  useSlidingRect,
  SlidingBackground,
  SlidingUnderline,
} from "@/components/ui/sliding-underline";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & {
    indicatorClassName?: string;
  }
>(({ className, children, indicatorClassName, ...props }, ref) => {
  const listRef =
    React.useRef<React.ElementRef<typeof TabsPrimitive.List>>(null);
  React.useImperativeHandle(ref, () => listRef.current!, []);
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
        "relative isolate inline-flex h-9 items-center justify-center gap-1 text-muted-foreground",
        className,
      )}
      {...props}
    >
      <SlidingBackground
        rect={rect}
        className={cn("bg-accent", indicatorClassName)}
      />
      {children}
    </TabsPrimitive.List>
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TRIGGER_ICON = "gap-2 [&_svg]:size-4 [&_svg]:shrink-0";

const triggerClass =
  "inline-flex cursor-pointer items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground";

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(triggerClass, "relative z-10", TRIGGER_ICON, className)}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

function SegmentedTabsList({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>) {
  return (
    <TabsList
      className={cn(
        "grid h-auto w-full auto-cols-fr grid-flow-col items-center rounded-lg border border-border bg-surface p-1",
        className,
      )}
      indicatorClassName="bg-background shadow-sm"
      {...props}
    />
  );
}
SegmentedTabsList.displayName = "SegmentedTabsList";

const SegmentedTabsTrigger = TabsTrigger;

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

const underlineTabClass =
  "inline-flex h-12 cursor-pointer items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap text-muted-foreground hover:text-foreground focus-visible:outline-none data-[state=active]:text-foreground";

const UnderlineTabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(underlineTabClass, TRIGGER_ICON, className)}
    {...props}
  />
));
UnderlineTabsTrigger.displayName = "UnderlineTabsTrigger";

export {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  SegmentedTabsList,
  SegmentedTabsTrigger,
  UnderlineTabsList,
  UnderlineTabsTrigger,
};
