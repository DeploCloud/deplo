"use client";

import * as React from "react";
import { Command, Search } from "lucide-react";

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
        "inline-flex items-center gap-0.5 font-sans text-xs text-muted-foreground/70",
        className,
      )}
    >
      <span className="sr-only">{mac ? "Command K" : "Control K"}</span>
      <span aria-hidden className="inline-flex items-center gap-0.5">
        {mac ? <Command className="size-3" /> : "⌃"}K
      </span>
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
      className="relative flex h-10 w-full cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg border border-sidebar-border bg-card pl-[11px] text-left text-sm whitespace-nowrap text-muted-foreground shadow-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none"
    >
      <Search className="pointer-events-none size-4 shrink-0" />
      <span className={cn(FADE, compact && "opacity-0")}>Search</span>
      <PaletteKbd
        className={cn(
          "pointer-events-none absolute top-1/2 right-3.5 hidden -translate-y-1/2 lg:inline-flex",
          FADE,
          compact && "opacity-0",
        )}
      />
    </button>
  );
}
