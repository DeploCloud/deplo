import { facePath, faceParts, isValidAvatarValue } from "./apps/avatar-shared";

/** A chosen face or an uploaded picture; null leaves the letters to the component. */
export function pictureUrl(image: string | null | undefined): string | null {
  const value = image?.trim();
  const parts = faceParts(value);
  if (parts) return facePath(parts.style, parts.preset, parts.seed);
  return value && isValidAvatarValue(value) ? value : null;
}

export const teamAvatarUrl = pictureUrl;

export const avatarUrlFor = (row: { image?: string | null }) =>
  pictureUrl(row.image);
