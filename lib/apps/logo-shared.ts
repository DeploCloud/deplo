export const LOGO_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/gif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
] as const;

export const LOGO_ACCEPT_ATTR = LOGO_IMAGE_TYPES.join(",");

export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

export const MAX_LOGO_STRING_LEN = Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 100;

const DATA_URI_RE =
  /^data:image\/(png|jpeg|webp|svg\+xml|gif|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+=*$/;

const TEMPLATE_PATH_RE = /^\/templates\/[A-Za-z0-9._-]+$/;

export function isValidLogoValue(value: string): boolean {
  if (value.length > MAX_LOGO_STRING_LEN) return false;
  if (DATA_URI_RE.test(value)) return true;
  if (TEMPLATE_PATH_RE.test(value)) return true;
  return false;
}

export const LOGO_EDGE_PX = 512;

export const CROPPABLE_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export function isAnimatedWebp(head: Uint8Array): boolean {
  if (head.length < 21) return false;
  const tag = (at: number) =>
    String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP" || tag(12) !== "VP8X")
    return false;
  return (head[20] & 0x02) !== 0;
}
