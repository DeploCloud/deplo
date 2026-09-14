// GRAVATAR_ORIGINS - the Gravatar hosts the dashboard CSP has to allow.
export const GRAVATAR_ORIGINS = [
  "https://gravatar.com",
  "https://secure.gravatar.com",
] as const;

// AVATAR_IMAGE_TYPES - narrower than LOGO_IMAGE_TYPES on purpose: no SVG, no ICO, no GIF.
export const AVATAR_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

// AVATAR_ACCEPT_ATTR - `accept` attribute for the avatar file input.
export const AVATAR_ACCEPT_ATTR = AVATAR_IMAGE_TYPES.join(",");

// AVATAR_EDGE_PX - the square the picker downscales to, in CSS pixels.
export const AVATAR_EDGE_PX = 256;

// MAX_AVATAR_BYTES - max size of the stored avatar, before base64 inflation.
export const MAX_AVATAR_BYTES = 256 * 1024;

// MAX_AVATAR_STRING_LEN - the server's last-line guard, independent of anything the client claims.
export const MAX_AVATAR_STRING_LEN =
  Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 100;

const AVATAR_DATA_URI_RE =
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

// isValidAvatarValue - the single gate the mutations, the picker and the read path all trust.
export function isValidAvatarValue(value: string): boolean {
  if (value.length > MAX_AVATAR_STRING_LEN) return false;
  return AVATAR_DATA_URI_RE.test(value);
}

// GRAVATAR_VALUE - the marker `users.image` holds when the picture comes from Gravatar.
export const GRAVATAR_VALUE = "gravatar";
// INITIALS_VALUE - the plain monogram, drawn by the app itself.
export const INITIALS_VALUE = "initials";

// AVATAR_STYLES - the presets offered per DiceBear style. https://www.dicebear.com/styles
export const AVATAR_STYLES = {
  glyphs: ["default"],
  planets: ["electric"],
  glass: ["default"],
  pixelbot: ["terminal"],
  initials: ["default", "greyscale", "sunrise", "electric"],
} as const;

export type AvatarStyle = keyof typeof AVATAR_STYLES;

// AVATAR_PACKS - the four packs the picker offers, in order.
export const AVATAR_PACKS = [
  { style: "glyphs", preset: "default", label: "Glyphs Default" },
  { style: "planets", preset: "electric", label: "Planets Electric" },
  { style: "glass", preset: "default", label: "Glass Default" },
  { style: "pixelbot", preset: "terminal", label: "Pixelbot Terminal" },
  { style: "initials", preset: "default", label: "Initials" },
] as const satisfies readonly {
  style: AvatarStyle;
  preset: string;
  label: string;
}[];

// DEFAULT_PACK - what a person with nothing chosen already wears: their letters.
export const DEFAULT_PACK = AVATAR_PACKS.find((p) => p.style === "initials")!;

// packsFor - the packs a picker offers; a team only ever gets its own letters.
export function packsFor(
  team?: boolean,
): readonly (typeof AVATAR_PACKS)[number][] {
  return team ? [DEFAULT_PACK] : AVATAR_PACKS;
}

// INITIALS_PRESETS - the four looks of one seed; `default` is what a name with nothing stored wears.
export const INITIALS_PRESETS = [
  { id: "default", label: "Initials" },
  { id: "greyscale", label: "Initials Greyscale" },
  { id: "sunrise", label: "Initials Sunrise" },
  { id: "electric", label: "Initials Electric" },
] as const;

// AVATAR_ATTRIBUTION - the credit CC BY asks for wherever the art is shown; the other styles are CC0.
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

// AVATAR_VARIANTS - the four pictures every pack is drawn in, never derived from an id or a name.
export const AVATAR_VARIANTS = ["nova", "orbit", "quasar", "rune"] as const;

// FALLBACK_SEED - what an `initials` preview is drawn from before there is a name.
export const FALLBACK_SEED = "deplo";

// previewSeed - what a picker draws its `initials` row from; a nameless team gets nothing.
export function previewSeed(letters: string, team?: boolean): string {
  return letters || (team ? "" : FALLBACK_SEED);
}

// avatarSeedFromName - a name as a seed; the palette comes from the whole string, so equal initials still differ.
export function avatarSeedFromName(
  ...parts: (string | null | undefined)[]
): string {
  for (const part of parts) {
    const seed = part
      ?.trim()
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64);
    if (seed) return seed;
  }
  return FALLBACK_SEED;
}

// initialsFallbackUrl - the picture a name falls back to when there is nothing stored.
export function initialsFallbackUrl(
  ...parts: (string | null | undefined)[]
): string {
  return facePath("initials", "default", avatarSeedFromName(...parts));
}

// randomFaceValue - the picture a brand-new account wears: a character pack, at random.
export function randomFaceValue(): string {
  const packs = AVATAR_PACKS.filter((p) => p.style !== "initials");
  const pack = packs[Math.floor(Math.random() * packs.length)]!;
  const seed =
    AVATAR_VARIANTS[Math.floor(Math.random() * AVATAR_VARIANTS.length)]!;
  return `${pack.style}:${pack.preset}:${seed}`;
}

// AvatarTile - one tile of a pack's row.
export type AvatarTile = {
  style: AvatarStyle;
  preset: string;
  seed: string;
  label: string;
  derived: boolean;
};

// packRow - the four pictures a pack offers; the initials pack varies the palette instead of the seed.
export function packRow(
  pack: { style: AvatarStyle; preset: string; label: string },
  letters: string,
): AvatarTile[] {
  if (pack.style === "initials")
    return INITIALS_PRESETS.map(({ id, label }) => ({
      style: "initials",
      preset: id,
      seed: letters,
      label,
      derived: id === "default",
    }));
  return AVATAR_VARIANTS.map((seed, i) => ({
    style: pack.style,
    preset: pack.preset,
    seed,
    label: `${pack.label} ${i + 1}`,
    derived: false,
  }));
}

// A seed lands in a URL path and in a render, so it stays to this shape.
const AVATAR_SEED_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidAvatarSeed(seed: string): boolean {
  return AVATAR_SEED_RE.test(seed);
}

// facePath - where a generated picture is served from; same origin, so the CSP already allows it.
export function facePath(
  style: AvatarStyle,
  preset: string,
  seed: string,
): string {
  return `/api/avatar/${style}/${preset}/${seed}.svg`;
}

// faceParts - the style, the look and the face inside a stored `<style>:<preset>:<seed>`.
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

// isValidUserAvatarValue - whether a person may store this; the instance flag decides whether Gravatar is honoured, not whether it is legal.
export function isValidUserAvatarValue(value: string): boolean {
  if (value === GRAVATAR_VALUE || value === INITIALS_VALUE) return true;
  if (faceParts(value)) return true;
  return isValidAvatarValue(value);
}

// isValidTeamAvatarValue - an uploaded picture or an initials look, never a character pack or `gravatar`.
export function isValidTeamAvatarValue(value: string): boolean {
  return faceParts(value)?.style === "initials" || isValidAvatarValue(value);
}

// avatarPreviewUrl - what the browser shows for a value it holds itself; Gravatar resolves server-side only.
export function avatarPreviewUrl(
  value: string | null | undefined,
): string | null {
  const parts = faceParts(value);
  if (parts) return facePath(parts.style, parts.preset, parts.seed);
  if (value && isValidAvatarValue(value)) return value;
  return null;
}

// AvatarChoice - which source a resolved `avatarUrl` came from.
export type AvatarChoice =
  | { kind: "generated"; style: AvatarStyle; preset: string; seed: string }
  | { kind: "uploaded"; src: string }
  | { kind: "gravatar" }
  | { kind: "initials" };

// avatarChoiceFromValue - the same answer from the raw stored value, before a URL exists.
export function avatarChoiceFromValue(
  value: string | null | undefined,
): AvatarChoice {
  const parts = faceParts(value);
  if (parts) return { kind: "generated", ...parts };
  if (value === GRAVATAR_VALUE) return { kind: "gravatar" };
  if (value && isValidAvatarValue(value))
    return { kind: "uploaded", src: value };
  return { kind: "initials" };
}

export function avatarChoiceFromUrl(
  url: string | null | undefined,
): AvatarChoice {
  if (!url) return { kind: "initials" };
  if (url.startsWith("data:")) return { kind: "uploaded", src: url };
  if (GRAVATAR_ORIGINS.some((o) => url.startsWith(o)))
    return { kind: "gravatar" };
  if (!url.startsWith("/api/avatar/")) return { kind: "initials" };
  const [style, preset, file] = url.slice("/api/avatar/".length).split("/");
  const parts = faceParts(
    `${style}:${preset}:${(file ?? "").replace(/\.svg$/, "")}`,
  );
  return parts ? { kind: "generated", ...parts } : { kind: "initials" };
}
