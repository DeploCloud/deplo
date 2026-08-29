"use client";

import * as React from "react";
import { Search } from "lucide-react";

import { describeUserAgent } from "@/lib/user-agent";
import { cn } from "@/lib/utils";
import { openPalette } from "./palette-open";

/**
 * The shortcut chip. Renders "Ctrl K" on the server and swaps to the Command
 * symbol after mount, so there is no hydration mismatch and no wrong label.
 */
/** Nothing ever changes, so there is nothing to subscribe to. */
const noSubscription = () => () => {};

/** Parsed once: the machine does not change under the tab. */
let isMac: boolean | undefined;
const readIsMac = () =>
  (isMac ??= describeUserAgent(navigator.userAgent).os === "macOS");
const notMac = () => false;

export function PaletteKbd({ className }: { className?: string }) {
  // Not an effect: the server has no user agent, and this is exactly the "one
  // value on the server, another in the browser" case useSyncExternalStore
  // exists for - so there is no mismatch and no second render to schedule.
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

/**
 * The sidebar's search box. It looks exactly like the Input it replaced - same
 * h-9, so the sidebar's rhythm is untouched - but it opens the palette instead
 * of accepting text. "Search" is real text, so it needs no aria-label.
 */
export function SearchTrigger() {
  return (
    <button
      type="button"
      onClick={openPalette}
      aria-keyshortcuts="Meta+K Control+K"
      className="relative flex h-9 w-full cursor-pointer items-center rounded-md border border-input bg-transparent pr-7 pl-8 text-left text-sm text-muted-foreground shadow-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none"
    >
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
      Search
      <PaletteKbd className="pointer-events-none absolute top-1/2 right-2 hidden -translate-y-1/2 lg:inline" />
    </button>
  );
}
