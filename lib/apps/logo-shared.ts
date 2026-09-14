// LOGO_IMAGE_TYPES are the image MIME types accepted for an uploaded logo.
export const LOGO_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/gif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
] as const;

// LOGO_ACCEPT_ATTR is the `accept` attribute for the logo file <input>.
export const LOGO_ACCEPT_ATTR = LOGO_IMAGE_TYPES.join(",");

// MAX_LOGO_BYTES is the max size of the raw image file, in bytes.
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

// MAX_LOGO_STRING_LEN is the server's guard on the stored logo string length.
export const MAX_LOGO_STRING_LEN = Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 100;

const DATA_URI_RE =
  /^data:image\/(png|jpeg|webp|svg\+xml|gif|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+=*$/;

// Apps created before the catalog moved to its own service still store this path shape.
const TEMPLATE_PATH_RE = /^\/templates\/[A-Za-z0-9._-]+$/;

// isValidLogoValue reports whether a stored logo value is acceptable.
export function isValidLogoValue(value: string): boolean {
  if (value.length > MAX_LOGO_STRING_LEN) return false;
  if (DATA_URI_RE.test(value)) return true;
  if (TEMPLATE_PATH_RE.test(value)) return true;
  return false;
}

// LOGO_EDGE_PX is the square the crop dialog exports a logo at, in CSS pixels.
export const LOGO_EDGE_PX = 512;

// CROPPABLE_LOGO_TYPES are the logo types the crop dialog can handle.
export const CROPPABLE_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

// isAnimatedWebp reports whether these leading bytes are an animated WebP.
export function isAnimatedWebp(head: Uint8Array): boolean {
  if (head.length < 21) return false;
  const tag = (at: number) =>
    String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP" || tag(12) !== "VP8X")
    return false;
  return (head[20] & 0x02) !== 0;
}
