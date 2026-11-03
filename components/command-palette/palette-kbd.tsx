"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { describeUserAgent } from "@/lib/user-agent";
import { cn } from "@/lib/utils";
import { openPalette } from "./palette-open";

const FADE = "transition-opacity duration-200";

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

// One box in both modes, so the rail switch only fades the label.
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
      className="relative flex h-10 w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-md border border-sidebar-border bg-card pl-[11px] text-left text-sm whitespace-nowrap text-muted-foreground shadow-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none"
    >
      <Search className="pointer-events-none size-4 shrink-0" />
      <span className={cn(FADE, compact && "opacity-0")}>Search</span>
      <PaletteKbd
        className={cn(
          "pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 lg:inline",
          FADE,
          compact && "opacity-0",
        )}
      />
    </button>
  );
}
