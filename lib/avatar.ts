import "server-only";

import { cache } from "react";
import { eq } from "drizzle-orm";

import { getDb } from "./db/client";
import { instanceSettings } from "./db/schema/control-plane";
import { sha256Hex } from "./crypto";
import {
  DEFAULT_PACK,
  facePath,
  faceParts,
  GRAVATAR_ORIGINS,
  GRAVATAR_VALUE,
  INITIALS_VALUE,
  isValidAvatarValue,
} from "./apps/avatar-shared";

/**
 * Where a person's or a team's picture comes from, resolved once on the server.
 */

/** The singleton row's PK. Mirrors `lib/data/instance-settings.ts`. */
const SETTINGS_ID = "default";

/**
 * Whether Gravatar fallback is on for this instance. No row at all is a fresh
 * instance, and it reads the column's own default - off, because nobody has
 * chosen to hand gravatar.com an address hash yet.
 */
export const gravatarEnabled = cache(async (): Promise<boolean> => {
  const [row] = await getDb()
    .select({ gravatarEnabled: instanceSettings.gravatarEnabled })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  return row?.gravatarEnabled ?? false;
});

/**
 * A person's Gravatar address. The service's default (`d=identicon`) would instead
 * paint a random geometric pattern over every person who never signed up for it.
 */
function gravatarUrl(email: string): string {
  return `${GRAVATAR_ORIGINS[0]}/avatar/${sha256Hex(
    email.trim().toLowerCase(),
  )}?s=160&d=404`;
}

/** A row far enough along to answer "what picture does this person have?". */
export type AvatarSource = {
  /** Seeds the generated face. Required so a new caller cannot forget it and
   *  silently drop a whole list back to monograms; null for somebody with no
   *  account here (an imported author). */
  userId: string | null;
  image?: string | null;
  email?: string | null;
};

/**
 * Resolve many people in one go: reads the instance flag once and hands back a
 * SYNC mapper, so a batch builder (`listMembers`, `loadUserIdentities`) maps N
 * rows without N awaits.
 *
 * A person chooses their source (see `avatar-shared.ts`); nothing chosen falls to
 * their Gravatar when the instance allows it, and then to a generated face.
 */
export async function avatarResolver(): Promise<
  (row: AvatarSource) => string | null
> {
  const gravatar = await gravatarEnabled();
  return (row) => {
    const value = row.image?.trim();
    const generated = row.userId
      ? facePath(DEFAULT_PACK.style, DEFAULT_PACK.preset, row.userId)
      : null;
    const parts = faceParts(value);
    if (parts) return facePath(parts.style, parts.preset, parts.seed);
    if (value === INITIALS_VALUE) return null;
    if (value && value !== GRAVATAR_VALUE && isValidAvatarValue(value))
      return value;
    const email = row.email?.trim();
    if (gravatar && email) return gravatarUrl(email);
    return generated;
  };
}

/** Single-row convenience for the handful of call sites that resolve one person. */
export async function avatarUrlFor(row: AvatarSource): Promise<string | null> {
  return (await avatarResolver())(row);
}

/**
 * A team's picture. Sync and flagless: a team has no email, so there is no
 * Gravatar to fall back to and nothing to ask the instance about - it is the
 * uploaded image or the monogram.
 */
export function teamAvatarUrl(image: string | null | undefined): string | null {
  const value = image?.trim();
  return value && isValidAvatarValue(value) ? value : null;
}
