"use client";

import * as React from "react";
import Link from "@/components/ui/link";
import { cn } from "@/lib/utils";

/**
 * The whole-card click target, stretched over everything at z-0. The content
 * layer above it is `pointer-events-none`, so every pixel shows the pointer
 * cursor and clicks fall through to this link; controls opt back in with
 * `data-card-actions` + `pointer-events-auto`.
 */
export function OverlayLink({
  href,
  label,
  inert = false,
}: {
  href: string;
  label: string;
  /** A drag is in flight → make the link inert so a drop never navigates. */
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
