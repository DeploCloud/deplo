/**
 * Upload constants shared between the server (lib/deploy/upload.ts, the route
 * handler) and the client (components/projects/upload-input.tsx). Kept free of
 * any Node-only / "server-only" imports so the browser bundle can use it,
 * which is the whole point: one source of truth for the size cap and the
 * accepted archive extensions instead of values drifting across the boundary.
 */

/** Hard ceiling on a single uploaded archive (bytes). */
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024; // 512 MiB

/**
 * Archive extensions we accept and know how to extract. `.tar.gz`/`.tgz`/`.tar`
 * go through `tar`; `.zip` through `unzip`. Order matters: `.tar.gz` must be
 * tested before `.tar` so the longer suffix wins.
 */
export const KNOWN_EXTS = [".tar.gz", ".tgz", ".tar", ".zip"] as const;

/** `accept` attribute for the file <input>. */
export const ACCEPT_ATTR = KNOWN_EXTS.join(",");

/** Client-side filename guard, mirroring KNOWN_EXTS. */
export const ACCEPT_RE = /\.(tar\.gz|tgz|tar|zip)$/i;

/** The recognised archive extension for a filename, or null if unsupported. */
export function archiveExt(filename: string): string | null {
  const lower = filename.toLowerCase();
  return KNOWN_EXTS.find((ext) => lower.endsWith(ext)) ?? null;
}
