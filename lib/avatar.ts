import "server-only";

import { cache } from "@/lib/request-cache";
import { eq } from "drizzle-orm";

import { prepared } from "./db/prepared";
import { instanceSettings } from "./db/schema/control-plane/instance";
import { sha256Hex } from "./crypto";
import {
  facePath,
  faceParts,
  GRAVATAR_ORIGINS,
  GRAVATAR_VALUE,
  INITIALS_VALUE,
  isValidAvatarValue,
} from "./apps/avatar-shared";

const SETTINGS_ID = "default";

// Whether Gravatar fallback is on for this instance; no row at all reads as off.
export const gravatarEnabled = cache(async (): Promise<boolean> => {
  const [row] = await prepared("gravatar-enabled", (db) =>
    db
      .select({ gravatarEnabled: instanceSettings.gravatarEnabled })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, SETTINGS_ID)),
  ).execute();
  return row?.gravatarEnabled ?? false;
});

// `d=404` on purpose: the service's default paints a random pattern over everyone who never signed up.
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

// Resolve many people in one go: reads the instance flag once and hands back a SYNC mapper.
export async function avatarResolver(): Promise<
  (row: AvatarSource) => string | null
> {
  const gravatar = await gravatarEnabled();
  return (row) => {
    const value = row.image?.trim();
    const parts = faceParts(value);
    if (parts) return facePath(parts.style, parts.preset, parts.seed);
    if (value === INITIALS_VALUE) return null;
    if (value && value !== GRAVATAR_VALUE && isValidAvatarValue(value))
      return value;
    const email = row.email?.trim();
    if (gravatar && email) return gravatarUrl(email);
    return null;
  };
}

/** Single-row convenience for the handful of call sites that resolve one person. */
export async function avatarUrlFor(row: AvatarSource): Promise<string | null> {
  return (await avatarResolver())(row);
}

// A team's picture: sync and flagless, because a team has no email and so no Gravatar to ask about.
export function teamAvatarUrl(image: string | null | undefined): string | null {
  const value = image?.trim();
  const parts = faceParts(value);
  if (parts) return facePath(parts.style, parts.preset, parts.seed);
  return value && isValidAvatarValue(value) ? value : null;
}
