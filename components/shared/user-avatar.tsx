"use client";

import * as React from "react";

import { Users } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initialsFallbackUrl } from "@/lib/apps/avatar-shared";
import { cn } from "@/lib/utils";

const SIZE = {
  xs: "size-4 text-[8px]",
  sm: "size-5 text-[9px]",
  md: "size-6 text-[10px]",
  lg: "size-8 text-xs",
  xl: "size-10 text-sm",
  "2xl": "size-12 text-base",
  "3xl": "size-16 text-lg",
  "4xl": "size-20 text-xl",
} as const;

export type AvatarSize = keyof typeof SIZE;

// avatarInitials - two letters for the monogram, from the first thing that reads like a name.
export function avatarInitials(
  ...parts: (string | null | undefined)[]
): string {
  for (const part of parts) {
    const value = part?.trim();
    if (!value) continue;
    const base = value.includes("@") ? value.split("@")[0]! : value;
    const letters = base.replace(/^@/, "").trim();
    if (letters) return letters.slice(0, 2).toUpperCase();
  }
  return "";
}

function Mark({
  src,
  size,
  className,
}: {
  src: string;
  size: AvatarSize;
  className?: string;
}) {
  return (
    <Avatar className={cn(SIZE[size], className)}>
      <AvatarImage
        src={src}
        alt=""
        // Without this, every avatar tells gravatar.com which page it was rendered on.
        referrerPolicy="no-referrer"
      />
      {/* A picture still arriving, or one that will not: a plain disc, never the letters. */}
      <AvatarFallback className="bg-muted" />
    </Avatar>
  );
}

// UserAvatar - a person; `alt=""` on purpose, it sits before their name and must not be read twice.
export function UserAvatar({
  name,
  username,
  avatarUrl,
  size = "lg",
  className,
}: {
  name?: string | null;
  username?: string | null;
  avatarUrl?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  return (
    <Mark
      src={avatarUrl || initialsFallbackUrl(name, username)}
      size={size}
      className={className}
    />
  );
}

export function TeamAvatar({
  name,
  avatarUrl,
  size = "md",
  className,
}: {
  name: string;
  avatarUrl?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  return (
    <Mark
      src={avatarUrl || initialsFallbackUrl(name)}
      size={size}
      className={className}
    />
  );
}

// TeamPlaceholder - a team with no name yet has no letters to draw, so it wears the generic mark.
export function TeamPlaceholder({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "grid aspect-square place-items-center rounded-full bg-muted text-muted-foreground",
        className,
      )}
    >
      <Users className="size-1/2" />
    </span>
  );
}
