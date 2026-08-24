import "server-only";

import { cache } from "react";
import { eq } from "drizzle-orm";

import { getDb } from "./db/client";
import { instanceSettings } from "./db/schema/control-plane";
import { sha256Hex } from "./crypto";
import { GRAVATAR_ORIGINS, isValidAvatarValue } from "./apps/avatar-shared";

/**
 * Where a person's or a team's picture comes from, resolved once on the server.
 *
 * This module is deliberately a LEAF: it imports the database client, the schema
 * and the hash, and nothing else. In particular it must never import `lib/auth`
 * or anything under `lib/data/` — `lib/data/instance-settings.ts` imports
 * `getCurrentUser` from `lib/auth`, and `lib/auth` needs the Gravatar flag, so
 * putting the flag read anywhere under `lib/data` closes an import cycle.
 *
 * The whole feature funnels through {@link avatarResolver}, and that is the
 * point. Every DTO that names a person carries a computed `avatarUrl` rather than
 * a raw `image` plus an email, which means:
 *  - the Gravatar switch is enforced in ONE place instead of in the ~25
 *    components that draw an avatar, so no component can bypass it;
 *  - **no DTO ever carries an email**. The address is selected into the query row
 *    and consumed here; only the derived URL leaves the data layer.
 */

/** The singleton row's PK. Mirrors `lib/data/instance-settings.ts`. */
const SETTINGS_ID = "default";

/**
 * Whether Gravatar fallback is on for this instance. Ungated and per-request
 * cached, for the same reason `logMaxDays` is: it is consulted while building
 * every DTO that names a person, takes no caller input, and reveals nothing
 * about anyone. Writing it is admin-only (`setGravatarEnabled`).
 *
 * No row at all is a fresh instance, which gets the column's own default rather
 * than a `false` that would silently turn the feature off before anyone chose to.
 */
export const gravatarEnabled = cache(async (): Promise<boolean> => {
  const [row] = await getDb()
    .select({ gravatarEnabled: instanceSettings.gravatarEnabled })
    .from(instanceSettings)
    .where(eq(instanceSettings.id, SETTINGS_ID));
  return row?.gravatarEnabled ?? true;
});

/**
 * A person's Gravatar address.
 *
 * `d=404` is load-bearing: it makes Gravatar answer 404 for somebody who has
 * none, the `<img>` fails, and the avatar falls back to their monogram. The
 * service's default (`d=identicon`) would instead paint a random geometric
 * pattern over every person who never signed up for it.
 *
 * SHA-256 of the lowercased, trimmed address — Gravatar's recommended form since
 * 2022, and the reason nothing here needs MD5 (there is none in this repo).
 */
function gravatarUrl(email: string): string {
  return `${GRAVATAR_ORIGINS[0]}/avatar/${sha256Hex(
    email.trim().toLowerCase(),
  )}?s=160&d=404`;
}

/** A row far enough along to answer "what picture does this person have?". */
export type AvatarSource = {
  image?: string | null;
  email?: string | null;
};

/**
 * Resolve many people in one go: reads the instance flag once and hands back a
 * SYNC mapper, so a batch builder (`listMembers`, `loadUserIdentities`) maps N
 * rows without N awaits.
 *
 * Precedence is uploaded picture, then Gravatar, then null (the monogram). The
 * stored value is re-validated on the way OUT as well as on the way in: a row
 * written before the validator tightened must never become a rendered `src`.
 */
export async function avatarResolver(): Promise<
  (row: AvatarSource) => string | null
> {
  const gravatar = await gravatarEnabled();
  return (row) => {
    const image = row.image?.trim();
    if (image && isValidAvatarValue(image)) return image;
    const email = row.email?.trim();
    if (gravatar && email) return gravatarUrl(email);
    return null;
  };
}

/** Single-row convenience for the handful of call sites that resolve one person. */
export async function avatarUrlFor(row: AvatarSource): Promise<string | null> {
  return (await avatarResolver())(row);
}

/**
 * A team's picture. Sync and flagless: a team has no email, so there is no
 * Gravatar to fall back to and nothing to ask the instance about — it is the
 * uploaded image or the monogram.
 */
export function teamAvatarUrl(image: string | null | undefined): string | null {
  const value = image?.trim();
  return value && isValidAvatarValue(value) ? value : null;
}
