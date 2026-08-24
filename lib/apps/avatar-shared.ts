/**
 * Profile-picture constants + validation, shared between the browser (the file
 * picker on the account and team forms) and the server (the mutations that
 * store the value). Free of any Node-only / "server-only" import so the client
 * bundle can use it, exactly like its sibling `logo-shared.ts`.
 *
 * A profile picture is stored inline on the row as a base64
 * `data:image/...;base64,...` URI - the same contract an App's logo has, and for
 * the same reason: the dashboard CSP allows no remote host, so the bytes travel
 * with the row rather than living behind a URL.
 *
 * It is NOT `isValidLogoValue` with a smaller number, and the difference is the
 * point:
 *  - a logo may also be a `/templates/<file>` path, which is meaningless as
 *    somebody's face;
 *  - a logo may be an SVG, which is a document with its own fetching and
 *    scripting rules rather than a picture. A person's avatar is uploaded from a
 *    camera roll, so nothing is lost by refusing it, and `createImageBitmap`
 *    (what the picker resizes with) handles SVG inconsistently anyway.
 */

/**
 * The Gravatar hosts the dashboard CSP has to allow.
 *
 * Here rather than beside the URL builder in `lib/avatar.ts` because `proxy.ts`
 * is the MIDDLEWARE: it cannot import a `server-only` module, and it is the one
 * place that has to name these hosts. Both are live — `gravatar.com` is what the
 * docs hand out today, `secure.gravatar.com` is what older integrations emit.
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

/** The square the picker downscales to, in CSS pixels. 256 is twice the largest
 *  place an avatar is drawn (`size-12`, 48px) on a 2x display, with room to
 *  spare - big enough that nothing looks soft, small enough that the encoded
 *  result is tens of kilobytes. */
export const AVATAR_EDGE_PX = 256;

/**
 * Max size of the STORED avatar, in bytes before base64 inflation.
 *
 * Much tighter than `MAX_LOGO_BYTES` (2 MiB) on purpose. A logo is read once per
 * Overview card; an avatar is inline on rows that the members table, every env
 * "Modified by" cell, the activity trail and the team switcher all read, so the
 * cost is paid per person per screen rather than per app. A 256x256 WebP lands
 * at 20-40 KB, so this is roughly 6x headroom over what the picker produces -
 * and it is the ONLY server-side size guarantee, because the resize happens in
 * the browser and a hostile client simply will not do it.
 */
export const MAX_AVATAR_BYTES = 256 * 1024; // 256 KiB raw

/**
 * Max length of the stored avatar string: the inflated base64 (4/3) plus the
 * `data:<mime>;base64,` prefix, with headroom. The server's last-line guard,
 * independent of anything the client claims.
 */
export const MAX_AVATAR_STRING_LEN = Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 100;

const AVATAR_DATA_URI_RE =
  /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/;

/**
 * Whether a stored avatar value is acceptable: a png/jpeg/webp image data-URI
 * within the cap. Anything else - a remote URL, a `/templates/...` path, an SVG,
 * `javascript:`, `data:text/html` - is rejected. Pure; the single gate the
 * mutations, the picker and the read path all trust.
 */
export function isValidAvatarValue(value: string): boolean {
  if (value.length > MAX_AVATAR_STRING_LEN) return false;
  return AVATAR_DATA_URI_RE.test(value);
}
