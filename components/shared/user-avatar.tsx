"use client";

import * as React from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { monogramColor } from "@/lib/avatar-colors";
import { cn, readableTextColor } from "@/lib/utils";

/**
 * The one way a person or a team is drawn before their name.
 *
 * Every surface that names somebody renders this, so the rules live in one place
 * instead of in the two dozen call sites that used to hand-roll
 * `slice(0, 2).toUpperCase()` and a hardcoded `color: "#000"`:
 *
 *  - the picture wins when there is one, and `avatarUrl` already decided WHICH
 *    picture (uploaded, else Gravatar, else nothing) back in the data layer —
 *    nothing here knows Gravatar exists;
 *  - a picture that fails to load falls back to the monogram on its own. Radix
 *    preloads the image and flips to the fallback on `error`, which is what a
 *    Gravatar `404` (the `d=404` we ask for), a CSP refusal and a missing `src`
 *    all produce. That is why this needs none of the broken-image bookkeeping
 *    `LogoImage` carries — that one is a bare `<img>`;
 *  - the monogram's text colour is DERIVED from its background. Two of the five
 *    avatar colours (`#7928ca`, `#0070f3`) are unreadable in black, which is what
 *    every call site used to hardcode.
 */

/** The sizes actually in use across the product, in Tailwind steps. */
const SIZE = {
  xs: "size-4 text-[8px]",
  sm: "size-5 text-[9px]",
  md: "size-6 text-[10px]",
  lg: "size-8 text-xs",
  xl: "size-10 text-sm",
  "2xl": "size-12 text-base",
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
   *  colour — a person being imported who has no deplo account yet. */
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
      {/* No `delayMs`. It exists to hide the monogram-then-photo swap on a remote
          image, but the common case here is somebody with NO Gravatar: their
          address 404s (that is what `d=404` asks for), so a delay would leave
          an empty ring on every page load and only then draw their initials.
          Initials-then-photo is what every product does and what people read as
          normal; an empty circle is not. */}
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
  /** The monogram's fill. Omitted (a Dokploy person being imported, say) ⇒ the
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
 * team's mark is cosmetic and referenced nowhere else, so a column would only
 * buy a colour picker in Settings that nobody asked for. Same five colours a
 * person gets, so the two marks read as one product.
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
