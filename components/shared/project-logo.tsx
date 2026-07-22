"use client";

import * as React from "react";
import { Box } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * An app's display avatar: its custom logo when one is set (defaulted from a
 * template on deploy, editable in settings), otherwise a generic glyph. A logo
 * that fails to load falls back to the glyph at runtime rather than showing a
 * broken image.
 */
export function AppLogo({
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
          "flex shrink-0 items-center justify-center rounded-md bg-secondary text-foreground",
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
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={logo}
        alt=""
        // The inset that keeps a full-bleed logo off the avatar's edge is worth
        // 4px of a 36px tile and a quarter of a 16px one — at menu-icon size it
        // would shrink the mark to a smudge, so it only applies once there is
        // room for it.
        className={cn("size-full object-contain", size >= 24 && "p-1")}
        loading="lazy"
        onError={() => setBroken(true)}
      />
    </span>
  );
}
