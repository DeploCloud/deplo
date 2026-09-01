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
 * uploaded data-URI or one of these markers. No value at all is the first pack,
 * seeded with their own id.
 */
export const GRAVATAR_VALUE = "gravatar";
/** The plain monogram - the one drawn by the app itself, not by DiceBear. */
export const INITIALS_VALUE = "initials";

/** The presets offered per DiceBear style: option sets over that one style, with
 *  the values DiceBear publishes. https://www.dicebear.com/styles */
export const AVATAR_STYLES = {
  glyphs: ["default"],
  planets: ["electric"],
  glass: ["default"],
  pixelbot: ["terminal"],
  initials: ["electric", "greyscale", "sunrise", "bold-pop"],
} as const;

export type AvatarStyle = keyof typeof AVATAR_STYLES;

/** The four packs the picker offers, in order. The first is what everyone wears
 *  until they choose. */
export const AVATAR_PACKS = [
  { style: "glyphs", preset: "default", label: "Glyphs Default" },
  { style: "planets", preset: "electric", label: "Planets Electric" },
  { style: "glass", preset: "default", label: "Glass Default" },
  { style: "pixelbot", preset: "terminal", label: "Pixelbot Terminal" },
] as const satisfies readonly {
  style: AvatarStyle;
  preset: string;
  label: string;
}[];

export const DEFAULT_PACK = AVATAR_PACKS[0];

/** The initials looks. Electric leads - it is the one to recommend. */
export const INITIALS_PRESETS = [
  { id: "electric", label: "Initials Electric" },
  { id: "greyscale", label: "Initials Greyscale" },
  { id: "sunrise", label: "Initials Sunrise" },
  { id: "bold-pop", label: "Initials Bold" },
] as const;

export const DEFAULT_INITIALS_PRESET = INITIALS_PRESETS[0].id;

/**
 * The credit CC BY asks for, wherever the art is shown: creator, source, licence,
 * and the fact that it is a remix. Copied from the style's own `meta.license`.
 * The other styles are CC0 and ask for nothing.
 */
export const AVATAR_ATTRIBUTION = {
  style: "Glyphs",
  source: "Abstract Avatars for All Creative Profile Use",
  sourceUrl: "https://www.figma.com/community/file/1249154526125777853",
  creator: "Matt Houser",
  creatorUrl: "https://x.com/mattkhouser",
  license: "CC BY 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
} as const;

export function isValidAvatarStyle(value: string): value is AvatarStyle {
  return value in AVATAR_STYLES;
}

export function isValidPreset(style: AvatarStyle, preset: string): boolean {
  return (AVATAR_STYLES[style] as readonly string[]).includes(preset);
}

/** The example faces every pack is offered in, beside the person's own. Fixed,
 *  not random: the tile you picked is still there next time, and cached. */
export const EXAMPLE_SEEDS = ["nova", "orbit", "quasar", "rune"] as const;

/** How many pictures a pack's row shows: the seed-generated one plus three. */
export const AVATAR_ROW = 4;

/** The row for one pack: the seed-generated one first, then the examples.
 *  Deduped, so somebody wearing an example does not see it twice. */
export function rowSeeds(ownSeed: string): string[] {
  return [ownSeed, ...EXAMPLE_SEEDS.filter((s) => s !== ownSeed)].slice(
    0,
    AVATAR_ROW,
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
    return facePath(DEFAULT_PACK.style, DEFAULT_PACK.preset, defaultSeed);
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
