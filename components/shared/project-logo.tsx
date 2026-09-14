"use client";

import * as React from "react";
import { Box } from "lucide-react";
import { cn } from "@/lib/utils";
import { plateClass } from "@/components/templates/veil";

// AppLogo - an app's display avatar: its own logo when set, otherwise a generic glyph.
export function AppLogo({
  logo,
  tone,
  size = 36,
  className,
}: {
  logo: string | null;
  tone?: "dark" | "light" | null;
  size?: number;
  className?: string;
}) {
  return (
    <LogoImage
      src={logo}
      size={size}
      className={cn(plateClass(tone ? { tone } : undefined), className)}
      fallback={<Box style={{ width: size * 0.5, height: size * 0.5 }} />}
    />
  );
}

// LogoImage - the avatar tile itself, shared by every resource that has a display logo.
export function LogoImage({
  src,
  size = 36,
  className,
  fallback,
}: {
  src: string | null;
  size?: number;
  className?: string;
  fallback: React.ReactNode;
}) {
  const [broken, setBroken] = React.useState(false);
  // A new source deserves a fresh attempt: otherwise a replaced logo shows the fallback until a remount.
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
        className={cn("size-full object-contain", size >= 24 && "p-1")}
        loading="lazy"
        onError={() => setBroken(true)}
      />
    </span>
  );
}
