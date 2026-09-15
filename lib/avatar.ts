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

export const gravatarEnabled = cache(async (): Promise<boolean> => {
  const [row] = await prepared("gravatar-enabled", (db) =>
    db
      .select({ gravatarEnabled: instanceSettings.gravatarEnabled })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, SETTINGS_ID)),
  ).execute();
  return row?.gravatarEnabled ?? false;
});

function gravatarUrl(email: string): string {
  return `${GRAVATAR_ORIGINS[0]}/avatar/${sha256Hex(
    email.trim().toLowerCase(),
  )}?s=160&d=404`;
}

export type AvatarSource = {
  image?: string | null;
  email?: string | null;
};

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

export async function avatarUrlFor(row: AvatarSource): Promise<string | null> {
  return (await avatarResolver())(row);
}

export function teamAvatarUrl(image: string | null | undefined): string | null {
  const value = image?.trim();
  const parts = faceParts(value);
  if (parts) return facePath(parts.style, parts.preset, parts.seed);
  return value && isValidAvatarValue(value) ? value : null;
}
