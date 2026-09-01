"use client";

import * as React from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { initialsFallbackUrl } from "@/lib/apps/avatar-shared";
import { cn } from "@/lib/utils";

/**
 * The one way a person or a team is drawn before their name.
 */

/** The sizes actually in use across the product, in Tailwind steps. */
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

/**
 * Two letters for the monogram, from the first thing that reads like a name.
 *
 * Takes the local part of an email, because the one place that passes one is the
 * migration picker, where a person being imported may have nothing else yet.
 */
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
  return "?";
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
        // Without this, every avatar tells gravatar.com which page of this panel
        // it was rendered on.
        referrerPolicy="no-referrer"
      />
      {/* A picture that is still arriving, or one that will not: a plain disc,
        never the letters - every avatar in the product is drawn by the same
        renderer now. */}
      <AvatarFallback className="bg-muted" />
    </Avatar>
  );
}

/**
 * A person. `alt=""` on purpose: this always sits immediately before their name,
 * so it is decorative and a screen reader must not read the name twice.
 */
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

/** A team. */
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
