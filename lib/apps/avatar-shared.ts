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
 * face, in the default look.
 */
export const PIXELBOT_PREFIX = "pixelbot:";
export const GRAVATAR_VALUE = "gravatar";
export const INITIALS_VALUE = "initials";

/**
 * The looks the picker offers: DiceBear's own Pixelbot presets, which are option
 * sets over the one style - never a second style.
 * https://www.dicebear.com/styles/pixelbot/presets/
 */
export const PIXELBOT_PRESETS = [
  { id: "default", label: "Default" },
  { id: "terminal", label: "Terminal" },
  { id: "amber", label: "Amber" },
  { id: "greyscale", label: "Greyscale" },
  { id: "duotone", label: "Duotone" },
  { id: "electric", label: "Electric" },
  { id: "cool", label: "Cool" },
  { id: "warm", label: "Warm" },
  { id: "sunrise", label: "Sunrise" },
] as const;

export type PixelbotPreset = (typeof PIXELBOT_PRESETS)[number]["id"];

/** What everyone wears until they choose. */
export const DEFAULT_PIXELBOT_PRESET: PixelbotPreset = "default";

export function isValidPixelbotPreset(value: string): value is PixelbotPreset {
  return PIXELBOT_PRESETS.some((p) => p.id === value);
}

/** What a seed may look like: it lands in a URL path and in a render. */
const PIXELBOT_SEED_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidPixelbotSeed(seed: string): boolean {
  return PIXELBOT_SEED_RE.test(seed);
}

/** Where a generated face is served from. Same origin, so the CSP already allows
 *  it and the renderer never reaches the browser bundle. */
export function pixelbotPath(preset: PixelbotPreset, seed: string): string {
  return `/api/avatar/${preset}/${seed}.svg`;
}

/** The look and the face inside a stored `pixelbot:<preset>:<seed>` marker. */
export function pixelbotParts(
  value: string | null | undefined,
): { preset: PixelbotPreset; seed: string } | null {
  if (!value?.startsWith(PIXELBOT_PREFIX)) return null;
  const [preset, ...rest] = value.slice(PIXELBOT_PREFIX.length).split(":");
  const seed = rest.join(":");
  return preset && isValidPixelbotPreset(preset) && isValidPixelbotSeed(seed)
    ? { preset, seed }
    : null;
}

/** Whether a person may store this. Gravatar is accepted whatever the instance
 *  flag says - the flag decides whether it is HONOURED, not whether it is legal. */
export function isValidUserAvatarValue(value: string): boolean {
  if (value === GRAVATAR_VALUE || value === INITIALS_VALUE) return true;
  if (pixelbotParts(value)) return true;
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
  const parts = pixelbotParts(value);
  if (parts) return pixelbotPath(parts.preset, parts.seed);
  if (value && isValidAvatarValue(value)) return value;
  if (!value && defaultSeed)
    return pixelbotPath(DEFAULT_PIXELBOT_PRESET, defaultSeed);
  return null;
}

/** Which source a resolved `avatarUrl` came from, so the picker can mark the
 *  one in use without a second field on every DTO. */
export type AvatarChoice =
  | { kind: "generated"; preset: PixelbotPreset; seed: string }
  | { kind: "uploaded" }
  | { kind: "gravatar" }
  | { kind: "initials" };

/** The same answer from the RAW stored value - what a form holds before it is
 *  saved, where the URL does not exist yet. */
export function avatarChoiceFromValue(
  value: string | null | undefined,
): AvatarChoice {
  const parts = pixelbotParts(value);
  if (parts) return { kind: "generated", ...parts };
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
  const [preset, file] = url.startsWith("/api/avatar/")
    ? url.slice("/api/avatar/".length).split("/")
    : [];
  const seed = file?.replace(/\.svg$/, "") ?? "";
  return preset && isValidPixelbotPreset(preset) && isValidPixelbotSeed(seed)
    ? { kind: "generated", preset, seed }
    : { kind: "initials" };
}
