"use client";

import * as React from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { monogramColor } from "@/lib/avatar-colors";
import { cn, readableTextColor } from "@/lib/utils";

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
  initials,
  background,
  size,
  className,
}: {
  src: string | null | undefined;
  initials: string;
  /** Hex fill for the monogram. Undefined only for somebody with no stored
   *  colour - a person being imported who has no deplo account yet. */
  background?: string;
  size: AvatarSize;
  className?: string;
}) {
  return (
    <Avatar className={cn(SIZE[size], className)}>
      <AvatarImage
        src={src ?? undefined}
        alt=""
        // Without this, every avatar tells gravatar.com which page of this panel
        // it was rendered on.
        referrerPolicy="no-referrer"
      />
      {/**
       * No `delayMs`.
       */}
      <AvatarFallback
        className={cn(
          "font-medium",
          !background && "bg-foreground text-background",
        )}
        style={
          background
            ? {
                backgroundColor: background,
                color: readableTextColor(background),
              }
            : undefined
        }
      >
        {initials}
      </AvatarFallback>
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
  avatarColor,
  avatarUrl,
  size = "lg",
  className,
}: {
  name?: string | null;
  username?: string | null;
  /** The monogram's fill. Omitted (an imported person, say) ⇒ the
   *  neutral mark, since they have no deplo account to have a colour on yet. */
  avatarColor?: string | null;
  avatarUrl?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  return (
    <Mark
      src={avatarUrl}
      initials={avatarInitials(name, username)}
      background={avatarColor ?? undefined}
      size={size}
      className={className}
    />
  );
}

/**
 * A team. Its monogram colour is DERIVED from the name rather than stored: a
 * team's mark is cosmetic and referenced nowhere else, so a column would only buy
 * a colour picker in Settings that nobody asked for.
 */
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
      src={avatarUrl}
      initials={avatarInitials(name)}
      background={monogramColor(name)}
      size={size}
      className={className}
    />
  );
}
