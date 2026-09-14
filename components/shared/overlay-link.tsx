"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { cn } from "@/lib/utils";

// OverlayLink is the whole-card click target, stretched over everything at z-0.
export function OverlayLink({
  href,
  label,
  inert = false,
}: {
  href: string;
  label: string;
  inert?: boolean;
}) {
  return (
    <Link
      href={href}
      aria-label={`Open ${label}`}
      tabIndex={inert ? -1 : undefined}
      aria-hidden={inert || undefined}
      className={cn(
        "absolute inset-0 z-0 rounded-xl",
        inert ? "pointer-events-none cursor-default" : "cursor-pointer",
      )}
    />
  );
}
