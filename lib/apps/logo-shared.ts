/**
 * App-logo constants + validation shared between the browser (the settings file
 * picker) and the server (the updateLogo action).
 */

/** Image MIME types accepted for an uploaded logo. `.ico` is included so a
 * detected `favicon.ico` (and a user-picked one) validates and renders - every
 * browser draws an ICO in an `<img>`. */
export const LOGO_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "image/gif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
] as const;

/** `accept` attribute for the logo file <input>. */
export const LOGO_ACCEPT_ATTR = LOGO_IMAGE_TYPES.join(",");

/**
 * Max size of the RAW image file (bytes). It is 2 MB because that is what the
 * platforms deplo imports from accept, and an icon that arrives with a migrated
 * app must not be the one thing that does not survive it.
 */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MiB raw

/**
 * Max length of the STORED logo string. This is the server's last-line guard
 * against an oversized value reaching the store regardless of what the client
 * claims the file size was.
 */
export const MAX_LOGO_STRING_LEN = Math.ceil((MAX_LOGO_BYTES * 4) / 3) + 100;

const DATA_URI_RE =
  /^data:image\/(png|jpeg|webp|svg\+xml|gif|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/]+=*$/;

/** A template's bundled logo: a clean, traversal-free `/templates/<file>` path
 * served from /public. Apps created before the catalog moved to its own service
 * still store this shape, so it stays valid; new ones inline the image instead. */
const TEMPLATE_PATH_RE = /^\/templates\/[A-Za-z0-9._-]+$/;

/**
 * Whether a stored logo value is acceptable: a recognised image data-URI, or a
 * local `/templates/...` path (the template-default case). Pure; the single gate
 * both the action and the UI trust.
 */
export function isValidLogoValue(value: string): boolean {
  if (value.length > MAX_LOGO_STRING_LEN) return false;
  if (DATA_URI_RE.test(value)) return true;
  if (TEMPLATE_PATH_RE.test(value)) return true;
  return false;
}

/**
 * The square the crop dialog exports a logo at, in CSS pixels.
 */
export const LOGO_EDGE_PX = 512;

/**
 * The logo types the crop dialog can handle.
 */
export const CROPPABLE_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/**
 * Whether these leading bytes are an ANIMATED WebP.
 */
export function isAnimatedWebp(head: Uint8Array): boolean {
  if (head.length < 21) return false;
  const tag = (at: number) =>
    String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP" || tag(12) !== "VP8X")
    return false;
  return (head[20] & 0x02) !== 0;
}
