"use client";

import * as React from "react";
import { CAPABILITY_META } from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Capability } from "@/lib/types";

/**
 * What the current viewer may do to the app they are looking at - published by the
 * app layout, read by every control inside it.
 */
const AppCapabilitiesContext = React.createContext<ReadonlySet<Capability>>(
  new Set<Capability>(),
);

export function AppCapabilitiesProvider({
  capabilities,
  children,
}: {
  capabilities: Capability[];
  children: React.ReactNode;
}) {
  // The array identity changes on every RSC payload; its contents don't, so key
  // the memo on the contents and every consumer below stops re-rendering.
  const key = capabilities.join(",");
  const value = React.useMemo(
    () => new Set<Capability>(key ? (key.split(",") as Capability[]) : []),
    [key],
  );
  return (
    <AppCapabilitiesContext.Provider value={value}>
      {children}
    </AppCapabilitiesContext.Provider>
  );
}

/** True when the viewer holds `cap` on the app currently open. */
export function useAppCan(cap: Capability): boolean {
  return React.useContext(AppCapabilitiesContext).has(cap);
}

/** The one-line reason a control is closed, named after the permission itself. */
export function needsCapability(cap: Capability): string {
  return `Needs the “${CAPABILITY_META[cap].label}” permission`;
}

/**
 * Makes a whole section read-only when the viewer lacks `cap`: a native `<fieldset
 * disabled>` (which disables every control inside it, however deeply nested) plus
 * one line saying why.
 */
export function CapabilityFieldset({
  cap,
  children,
}: {
  cap: Capability;
  children: React.ReactNode;
}) {
  const can = useAppCan(cap);
  if (can) return <>{children}</>;
  return (
    <>
      <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
        Read only. {needsCapability(cap)}.
      </p>
      <fieldset disabled className="contents">
        {children}
      </fieldset>
    </>
  );
}

/**
 * Wraps a control that is disabled for lack of `cap` so hovering still says why.
 */
export function CapabilityTip({
  cap,
  children,
  className,
}: {
  cap: Capability;
  children: React.ReactNode;
  /** Layout for the wrapper - pass the row's own classes when wrapping several
   *  controls at once, so their spacing survives. */
  className?: string;
}) {
  const can = useAppCan(cap);
  if (can) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex cursor-not-allowed", className)}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{needsCapability(cap)}</TooltipContent>
    </Tooltip>
  );
}
