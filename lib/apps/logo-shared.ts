/**
 * App-logo constants + validation shared between the browser (the settings
 * file picker) and the server (the updateLogo action). Kept free of any
 * Node-only / "server-only" imports so the client bundle can use it — one
 * source of truth for the size cap, the accepted image types, and what a
 * storable logo value may look like.
 *
 * A project logo is stored inline on the project as either:
 *  - a base64 `data:image/...;base64,...` URI (a user-uploaded image), or
 *  - a local `/templates/<file>` path (a template's bundled logo, served from
 *    /public and allowed by the dashboard CSP's `img-src 'self'`).
 * Both render under the strict CSP (`img-src 'self' blob: data:`) with no
 * remote fetch, which is why we inline the bytes rather than store a URL.
 */

/** Image MIME types accepted for an uploaded logo. `.ico` is included so a
 * detected `favicon.ico` (and a user-picked one) validates and renders — every
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
 * Max size of the RAW image file (bytes). Base64 inflates by ~4/3, so the stored
 * data-URI string is at most ~2.8 MB.
 *
 * It is 2 MB because that is what the platforms deplo imports from accept, and an
 * icon that arrives with a migrated app must not be the one thing that does not
 * survive it. Everything else here pays for that ceiling, so keep it in mind
 * before raising it again: the same cap bounds the file picker, favicon
 * detection and the template catalog, and the logo is inline on the row, so
 * every read of the Overview grid carries one per app.
 */
export const MAX_LOGO_BYTES = 2 * 1024 * 1024; // 2 MiB raw

/**
 * Max length of the STORED logo string. Covers the inflated base64 data URI
 * (4/3 × MAX_LOGO_BYTES, plus the `data:<mime>;base64,` prefix) with headroom.
 * This is the server's last-line guard against an oversized value reaching the
 * store regardless of what the client claims the file size was.
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
 * local `/templates/...` path (the template-default case). Anything else —
 * remote URLs, `javascript:`/`data:text` URIs, path traversal — is rejected.
 * Pure; the single gate both the action and the UI trust.
 */
export function isValidLogoValue(value: string): boolean {
  if (value.length > MAX_LOGO_STRING_LEN) return false;
  if (DATA_URI_RE.test(value)) return true;
  if (TEMPLATE_PATH_RE.test(value)) return true;
  return false;
}

/**
 * The square the crop dialog exports a logo at, in CSS pixels. Twice
 * `AVATAR_EDGE_PX` because a logo is drawn on the Overview card at 36-48px but
 * also as the app's own mark in wider places, and because a cropped logo is the
 * only one that gets re-encoded at all - everything else still travels at its
 * original size, up to {@link MAX_LOGO_BYTES}.
 */
export const LOGO_EDGE_PX = 512;

/**
 * The logo types the crop dialog can handle.
 *
 * Narrower than {@link LOGO_IMAGE_TYPES} because a canvas is raster-only: an
 * SVG is a document that would come out rasterised, an ICO is several pictures
 * of which it would keep one, and the whole point of a GIF is that it moves.
 * Those three keep the plain read-and-store path and land exactly as uploaded.
 */
export const CROPPABLE_LOGO_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

/**
 * Whether these leading bytes are an ANIMATED WebP.
 *
 * WebP is the one croppable type that can also be a moving picture, and
 * `createImageBitmap` would silently keep frame one - so an animated logo that
 * used to be stored intact would come back still. The flag lives in the
 * extended header: `RIFF....WEBPVP8X`, then a 4-byte chunk size, then a flags
 * byte whose bit 1 is ANIM.
 */
export function isAnimatedWebp(head: Uint8Array): boolean {
  if (head.length < 21) return false;
  const tag = (at: number) =>
    String.fromCharCode(head[at], head[at + 1], head[at + 2], head[at + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP" || tag(12) !== "VP8X")
    return false;
  return (head[20] & 0x02) !== 0;
}
