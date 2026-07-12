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
 * Max size of the RAW image file the user picks (bytes). Base64 inflates by
 * ~4/3, so the stored data-URI string is at most ~683 KB — small enough to live
 * inline in the JSON store without bloating it. Keep this conservative: every
 * read of the project document carries the logo.
 */
export const MAX_LOGO_BYTES = 512 * 1024; // 512 KiB raw

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
 * served from /public. This is the shape `createApp` stores from a
 * template's default logo. */
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
 * Whether a stored logo is a TEMPLATE DEFAULT (a `/templates/<file>` path) as
 * opposed to a user-uploaded / auto-detected inline image. A template's default
 * icon ALWAYS wins over favicon auto-detection: neither the automatic hooks nor
 * the manual "Detect from source" action may replace it (the user must remove
 * it first). Kept here, next to the value grammar, as the single source of truth.
 */
export function isTemplateLogo(value: string | null | undefined): boolean {
  return typeof value === "string" && TEMPLATE_PATH_RE.test(value);
}
