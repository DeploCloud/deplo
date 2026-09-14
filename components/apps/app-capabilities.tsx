"use client";

import * as React from "react";
import { CAPABILITY_META } from "@/lib/capabilities";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { Capability } from "@/lib/types/identity";

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

// useAppCan - true when the viewer holds `cap` on the app currently open.
export function useAppCan(cap: Capability): boolean {
  return React.useContext(AppCapabilitiesContext).has(cap);
}

// needsCapability - the one-line reason a control is closed.
export function needsCapability(cap: Capability): string {
  return `Needs the “${CAPABILITY_META[cap].label}” permission`;
}

// CapabilityFieldset - makes a whole section read-only when the viewer lacks `cap`.
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
      <p className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-muted-foreground">
        Read only. {needsCapability(cap)}.
      </p>
      <fieldset disabled className="contents">
        {children}
      </fieldset>
    </>
  );
}

// CapabilityTip - wraps a control disabled for lack of `cap` so hovering says why.
export function CapabilityTip({
  cap,
  children,
  className,
}: {
  cap: Capability;
  children: React.ReactNode;
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
