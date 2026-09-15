export const GRAVATAR_ORIGINS = [
  "https://gravatar.com",
  "https://secure.gravatar.com",
] as const;

export const AVATAR_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export const AVATAR_ACCEPT_ATTR = AVATAR_IMAGE_TYPES.join(",");

export const AVATAR_EDGE_PX = 256;

export const MAX_AVATAR_BYTES = 256 * 1024;

export const MAX_AVATAR_STRING_LEN =
  Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 100;

const AVATAR_DATA_URI_RE =
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

export function isValidAvatarValue(value: string): boolean {
  if (value.length > MAX_AVATAR_STRING_LEN) return false;
  return AVATAR_DATA_URI_RE.test(value);
}

export const GRAVATAR_VALUE = "gravatar";
export const INITIALS_VALUE = "initials";

export const AVATAR_STYLES = {
  glyphs: ["default"],
  planets: ["electric"],
  glass: ["default"],
  pixelbot: ["terminal"],
  initials: ["default", "greyscale", "sunrise", "electric"],
} as const;

export type AvatarStyle = keyof typeof AVATAR_STYLES;

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

export const DEFAULT_PACK = AVATAR_PACKS.find((p) => p.style === "initials")!;

export function packsFor(
  team?: boolean,
): readonly (typeof AVATAR_PACKS)[number][] {
  return team ? [DEFAULT_PACK] : AVATAR_PACKS;
}

export const INITIALS_PRESETS = [
  { id: "default", label: "Initials" },
  { id: "greyscale", label: "Initials Greyscale" },
  { id: "sunrise", label: "Initials Sunrise" },
  { id: "electric", label: "Initials Electric" },
] as const;

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

export const AVATAR_VARIANTS = ["nova", "orbit", "quasar", "rune"] as const;

export const FALLBACK_SEED = "deplo";

export function previewSeed(letters: string, team?: boolean): string {
  return letters || (team ? "" : FALLBACK_SEED);
}

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

export function initialsFallbackUrl(
  ...parts: (string | null | undefined)[]
): string {
  return facePath("initials", "default", avatarSeedFromName(...parts));
}

export function randomFaceValue(): string {
  const packs = AVATAR_PACKS.filter((p) => p.style !== "initials");
  const pack = packs[Math.floor(Math.random() * packs.length)]!;
  const seed =
    AVATAR_VARIANTS[Math.floor(Math.random() * AVATAR_VARIANTS.length)]!;
  return `${pack.style}:${pack.preset}:${seed}`;
}

export type AvatarTile = {
  style: AvatarStyle;
  preset: string;
  seed: string;
  label: string;
  derived: boolean;
};

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

const AVATAR_SEED_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidAvatarSeed(seed: string): boolean {
  return AVATAR_SEED_RE.test(seed);
}

export function facePath(
  style: AvatarStyle,
  preset: string,
  seed: string,
): string {
  return `/api/avatar/${style}/${preset}/${seed}.svg`;
}

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

export function isValidUserAvatarValue(value: string): boolean {
  if (value === GRAVATAR_VALUE || value === INITIALS_VALUE) return true;
  if (faceParts(value)) return true;
  return isValidAvatarValue(value);
}

export function isValidTeamAvatarValue(value: string): boolean {
  return faceParts(value)?.style === "initials" || isValidAvatarValue(value);
}

export function avatarPreviewUrl(
  value: string | null | undefined,
): string | null {
  const parts = faceParts(value);
  if (parts) return facePath(parts.style, parts.preset, parts.seed);
  if (value && isValidAvatarValue(value)) return value;
  return null;
}

export type AvatarChoice =
  | { kind: "generated"; style: AvatarStyle; preset: string; seed: string }
  | { kind: "uploaded"; src: string }
  | { kind: "gravatar" }
  | { kind: "initials" };

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
