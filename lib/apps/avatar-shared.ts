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
export const GRAVATAR_VALUE = "gravatar";
/** The plain monogram - the one drawn by the app itself, not by DiceBear. */
export const INITIALS_VALUE = "initials";

/**
 * The two DiceBear styles a person can wear, each with the style's own presets -
 * option sets over that one style, never a third style.
 * https://www.dicebear.com/styles/pixelbot/presets/
 */
export const AVATAR_STYLES = {
  pixelbot: [
    { id: "default", label: "Default" },
    { id: "terminal", label: "Terminal" },
    { id: "amber", label: "Amber" },
    { id: "greyscale", label: "Greyscale" },
    { id: "duotone", label: "Duotone" },
    { id: "electric", label: "Electric" },
    { id: "cool", label: "Cool" },
    { id: "warm", label: "Warm" },
    { id: "sunrise", label: "Sunrise" },
  ],
  initials: [
    { id: "electric", label: "Electric" },
    { id: "greyscale", label: "Greyscale" },
    { id: "sunrise", label: "Sunrise" },
    { id: "duotone", label: "Duotone" },
    { id: "bold-pop", label: "Bold" },
    { id: "sepia", label: "Sepia" },
  ],
} as const;

export type AvatarStyle = keyof typeof AVATAR_STYLES;
export const PIXELBOT_PRESETS = AVATAR_STYLES.pixelbot;
export const INITIALS_PRESETS = AVATAR_STYLES.initials;

/** What everyone wears until they choose. */
export const DEFAULT_PIXELBOT_PRESET = "default";
/** What the initials row leads with. */
export const DEFAULT_INITIALS_PRESET = "electric";

export function isValidAvatarStyle(value: string): value is AvatarStyle {
  return value === "pixelbot" || value === "initials";
}

export function isValidPreset(style: AvatarStyle, preset: string): boolean {
  return AVATAR_STYLES[style].some((p) => p.id === preset);
}

/** The faces every look is offered in. Fixed, not random: the tile you picked is
 *  still there next time, and the browser has it cached. */
export const PIXELBOT_SEEDS = [
  "nova",
  "orbit",
  "quasar",
  "rune",
  "vega",
  "zinc",
] as const;

/** How many faces a look's row shows. */
export const PIXELBOT_ROW = 6;

/** The row for one look: their own face first, then the fixed ones. Deduped, so
 *  somebody wearing a fixed seed does not see it twice. */
export function pixelbotRowSeeds(ownSeed: string): string[] {
  return [ownSeed, ...PIXELBOT_SEEDS.filter((s) => s !== ownSeed)].slice(
    0,
    PIXELBOT_ROW,
  );
}

/** What a seed may look like: it lands in a URL path and in a render. For the
 *  initials style the seed IS the letters, which is why it may be two of them. */
const AVATAR_SEED_RE = /^[A-Za-z0-9_?-]{1,64}$/;

export function isValidAvatarSeed(seed: string): boolean {
  return AVATAR_SEED_RE.test(seed);
}

/** Where a generated picture is served from. Same origin, so the CSP already
 *  allows it and the renderer never reaches the browser bundle. */
export function facePath(
  style: AvatarStyle,
  preset: string,
  seed: string,
): string {
  return `/api/avatar/${style}/${preset}/${seed}.svg`;
}

/** The style, the look and the face inside a stored `<style>:<preset>:<seed>`. */
export function faceParts(
  value: string | null | undefined,
): { style: AvatarStyle; preset: string; seed: string } | null {
  if (!value) return null;
  const [style, preset, ...rest] = value.split(":");
  const seed = rest.join(":");
  return style &&
    preset &&
    isValidAvatarStyle(style) &&
    isValidPreset(style, preset) &&
    isValidAvatarSeed(seed)
    ? { style, preset, seed }
    : null;
}

/** Whether a person may store this. Gravatar is accepted whatever the instance
 *  flag says - the flag decides whether it is HONOURED, not whether it is legal. */
export function isValidUserAvatarValue(value: string): boolean {
  if (value === GRAVATAR_VALUE || value === INITIALS_VALUE) return true;
  if (faceParts(value)) return true;
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
  const parts = faceParts(value);
  if (parts) return facePath(parts.style, parts.preset, parts.seed);
  if (value && isValidAvatarValue(value)) return value;
  if (!value && defaultSeed)
    return facePath("pixelbot", DEFAULT_PIXELBOT_PRESET, defaultSeed);
  return null;
}

/** Which source a resolved `avatarUrl` came from, so the picker can mark the
 *  one in use without a second field on every DTO. */
export type AvatarChoice =
  | { kind: "generated"; style: AvatarStyle; preset: string; seed: string }
  | { kind: "uploaded" }
  | { kind: "gravatar" }
  | { kind: "initials" };

/** The same answer from the RAW stored value - what a form holds before it is
 *  saved, where the URL does not exist yet. */
export function avatarChoiceFromValue(
  value: string | null | undefined,
): AvatarChoice {
  const parts = faceParts(value);
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
  if (!url.startsWith("/api/avatar/")) return { kind: "initials" };
  const [style, preset, file] = url.slice("/api/avatar/".length).split("/");
  const parts = faceParts(
    `${style}:${preset}:${(file ?? "").replace(/\.svg$/, "")}`,
  );
  return parts ? { kind: "generated", ...parts } : { kind: "initials" };
}
