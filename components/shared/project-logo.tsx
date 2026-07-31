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
  return (
    <LogoImage
      src={logo}
      size={size}
      className={className}
      fallback={<Box style={{ width: size * 0.5, height: size * 0.5 }} />}
    />
  );
}

/**
 * The avatar tile itself, shared by every resource that has a display logo (an
 * App's uploaded/template logo, a database's uploaded logo or its engine's brand
 * mark). Renders `src` as an image; a missing OR broken source falls back to the
 * caller's glyph on the same muted tile, so a dead data-URI never shows a broken
 * image. Kept sizing-only: the caller decides what the fallback glyph is.
 */
export function LogoImage({
  src,
  size = 36,
  className,
  fallback,
}: {
  /** Image source: a data-URI or a same-origin path (the CSP allows no host). */
  src: string | null;
  size?: number;
  className?: string;
  fallback: React.ReactNode;
}) {
  const [broken, setBroken] = React.useState(false);
  // A new source deserves a fresh attempt — otherwise replacing a broken logo
  // would keep showing the fallback until a remount.
  const [triedSrc, setTriedSrc] = React.useState(src);
  if (triedSrc !== src) {
    setTriedSrc(src);
    setBroken(false);
  }

  if (!src || broken) {
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-md bg-secondary text-foreground",
          className,
        )}
        style={{ width: size, height: size }}
      >
        {fallback}
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
        src={src}
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
