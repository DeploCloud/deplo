/**
 * Profile-picture constants + validation, shared between the browser (the file
 * picker on the account and team forms) and the server (the mutations that store
 * the value).
 */

/**
 * The Gravatar hosts the dashboard CSP has to allow.
 */
export const GRAVATAR_ORIGINS = [
  "https://gravatar.com",
  "https://secure.gravatar.com",
] as const;

/** Image MIME types accepted for an uploaded avatar. Deliberately narrower than
 *  `LOGO_IMAGE_TYPES`: no SVG, no ICO, no GIF - a profile picture comes off a
 *  phone or a camera, and the picker re-encodes whatever it is given to WebP. */
export const AVATAR_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/** `accept` attribute for the avatar file <input>. */
export const AVATAR_ACCEPT_ATTR = AVATAR_IMAGE_TYPES.join(",");

/**
 * The square the picker downscales to, in CSS pixels.
 */
export const AVATAR_EDGE_PX = 256;

/**
 * Max size of the STORED avatar, in bytes before base64 inflation.
 */
export const MAX_AVATAR_BYTES = 256 * 1024; // 256 KiB raw

/**
 * Max length of the stored avatar string: the inflated base64 (4/3) plus the
 * `data:<mime>;base64,` prefix, with headroom. The server's last-line guard,
 * independent of anything the client claims.
 */
export const MAX_AVATAR_STRING_LEN =
  Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 100;

const AVATAR_DATA_URI_RE =
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

/**
 * Whether a stored avatar value is acceptable: a png/jpeg/webp image data-URI
 * within the cap. Pure; the single gate the mutations, the picker and the read
 * path all trust. A TEAM only ever stores this - the sources below are a person's.
 */
export function isValidAvatarValue(value: string): boolean {
  if (value.length > MAX_AVATAR_STRING_LEN) return false;
  return AVATAR_DATA_URI_RE.test(value);
}

/**
 * A person picks where their picture comes from, so `users.image` holds either an
 * uploaded data-URI or one of these markers. No value at all is the generated
 * face, seeded with their own id.
 */
export const PIXELBOT_PREFIX = "pixelbot:";
export const GRAVATAR_VALUE = "gravatar";
export const INITIALS_VALUE = "initials";

/** The faces the picker offers. Seeds, not pictures: the SVG is rendered from
 *  these, so adding one costs a word. */
export const PIXELBOT_PRESETS = [
  "amber",
  "bolt",
  "cinder",
  "dusk",
  "ember",
  "fern",
  "gizmo",
  "halo",
  "indigo",
  "juno",
  "kite",
  "lumen",
] as const;

/** What a seed may look like: it lands in a URL path and in a render. */
const PIXELBOT_SEED_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidPixelbotSeed(seed: string): boolean {
  return PIXELBOT_SEED_RE.test(seed);
}

/** Where a generated face is served from. Same origin, so the CSP already allows
 *  it and the renderer never reaches the browser bundle. */
export function pixelbotPath(seed: string): string {
  return `/api/avatar/${seed}.svg`;
}

/** The seed inside a stored `pixelbot:` marker, or null if this is not one. */
export function pixelbotSeed(value: string | null | undefined): string | null {
  if (!value?.startsWith(PIXELBOT_PREFIX)) return null;
  const seed = value.slice(PIXELBOT_PREFIX.length);
  return isValidPixelbotSeed(seed) ? seed : null;
}

/** Whether a person may store this. Gravatar is accepted whatever the instance
 *  flag says - the flag decides whether it is HONOURED, not whether it is legal. */
export function isValidUserAvatarValue(value: string): boolean {
  if (value === GRAVATAR_VALUE || value === INITIALS_VALUE) return true;
  if (pixelbotSeed(value)) return true;
  return isValidAvatarValue(value);
}

/**
 * What the browser should show for a value it holds itself - the account form and
 * the onboarding draft. Gravatar resolves server-side only (it needs the address),
 * so here it reads as the monogram.
 */
export function avatarPreviewUrl(
  value: string | null | undefined,
  defaultSeed?: string | null,
): string | null {
  const seed = pixelbotSeed(value);
  if (seed) return pixelbotPath(seed);
  if (value && isValidAvatarValue(value)) return value;
  if (!value && defaultSeed) return pixelbotPath(defaultSeed);
  return null;
}

/** Which source a resolved `avatarUrl` came from, so the picker can mark the
 *  one in use without a second field on every DTO. */
export type AvatarChoice =
  | { kind: "generated"; seed: string }
  | { kind: "uploaded" }
  | { kind: "gravatar" }
  | { kind: "initials" };

/** The same answer from the RAW stored value - what a form holds before it is
 *  saved, where the URL does not exist yet. */
export function avatarChoiceFromValue(
  value: string | null | undefined,
): AvatarChoice {
  const seed = pixelbotSeed(value);
  if (seed) return { kind: "generated", seed };
  if (value === GRAVATAR_VALUE) return { kind: "gravatar" };
  if (value && isValidAvatarValue(value)) return { kind: "uploaded" };
  return { kind: "initials" };
}

export function avatarChoiceFromUrl(
  url: string | null | undefined,
): AvatarChoice {
  if (!url) return { kind: "initials" };
  if (url.startsWith("data:")) return { kind: "uploaded" };
  if (GRAVATAR_ORIGINS.some((o) => url.startsWith(o)))
    return { kind: "gravatar" };
  const seed = url.startsWith("/api/avatar/")
    ? url.slice("/api/avatar/".length).replace(/\.svg$/, "")
    : "";
  return isValidPixelbotSeed(seed)
    ? { kind: "generated", seed }
    : { kind: "initials" };
}
