"use client";

import * as React from "react";
import { SimpleTooltip } from "@/components/ui/tooltip";

export function MenuAction({
  tooltip,
  disabled,
  children,
}: {
  tooltip: string;
  disabled?: boolean;
  children: React.ReactElement;
}) {
  return (
    <SimpleTooltip content={tooltip} side="left">
      {disabled ? <span className="block">{children}</span> : children}
    </SimpleTooltip>
  );
}
