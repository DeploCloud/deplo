"use client";

import * as React from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";

// MenuAction - a menu item whose tooltip survives being disabled: a disabled
// item drops its pointer events, so the reason needs a wrapper to hover on.
export function MenuAction({
  tooltip,
  disabled,
  children,
}: {
  tooltip: string;
  disabled?: boolean;
  /** Exactly one element - `TooltipTrigger asChild` clones it. */
  children: React.ReactElement;
}) {
  return (
    <SimpleTooltip content={tooltip} side="left">
      {disabled ? <span className="block">{children}</span> : children}
    </SimpleTooltip>
  );
}
