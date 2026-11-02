"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { describeUserAgent } from "@/lib/user-agent";
import { cn } from "@/lib/utils";
import { openPalette } from "./palette-open";

const noSubscription = () => () => {};

let isMac: boolean | undefined;
const readIsMac = () =>
  (isMac ??= describeUserAgent(navigator.userAgent).os === "macOS");
const notMac = () => false;

export function PaletteKbd({ className }: { className?: string }) {
  const mac = React.useSyncExternalStore(noSubscription, readIsMac, notMac);

  return (
    <kbd
      className={cn(
        "rounded border border-border bg-muted px-1.5 text-[10px] text-muted-foreground",
        className,
      )}
    >
      {mac ? "⌘K" : "Ctrl K"}
    </kbd>
  );
}

// Compact is the icon rail: a 40px cell, like every other rail item.
export function SearchTrigger({
  compact = false,
  onClick,
  ...props
}: { compact?: boolean } & React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      {...props}
      onClick={(e) => {
        onClick?.(e);
        openPalette();
      }}
      aria-keyshortcuts="Meta+K Control+K"
      aria-label="Search"
      className={cn(
        "relative flex h-9 cursor-pointer items-center overflow-hidden rounded-md border border-sidebar-border bg-card text-left text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none",
        compact ? "w-10 justify-center" : "w-full pr-7 pl-8",
      )}
    >
      <Search
        className={cn(
          "pointer-events-none size-4 shrink-0",
          !compact && "absolute top-1/2 left-2.5 -translate-y-1/2",
        )}
      />
      {!compact && (
        <>
          <span>Search</span>
          <PaletteKbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 lg:inline" />
        </>
      )}
    </button>
  );
}
