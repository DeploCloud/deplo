"use client";

import * as React from "react";
import { Box } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * A service's display avatar: its custom logo when one is set (defaulted from a
 * template on deploy, editable in settings), otherwise a generic glyph. A logo
 * that fails to load falls back to the glyph at runtime rather than showing a
 * broken image.
 */
export function ServiceLogo({
  logo,
  size = 36,
  className,
}: {
  logo: string | null;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = React.useState(false);

  if (!logo || broken) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md border border-border bg-secondary text-foreground",
          className,
        )}
        style={{ width: size, height: size }}
      >
        <Box style={{ width: size * 0.5, height: size * 0.5 }} />
      </span>
    );
  }

  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={logo}
        alt=""
        className="size-full object-contain p-1"
        loading="lazy"
        onError={() => setBroken(true)}
      />
    </span>
  );
}
