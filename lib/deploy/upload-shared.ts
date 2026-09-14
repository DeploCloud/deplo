// MAX_UPLOAD_BYTES is the hard ceiling on a single uploaded archive.
export const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

// KNOWN_EXTS are the accepted archive extensions, longest suffix first (archiveExt takes the first match).
export const KNOWN_EXTS = [".tar.gz", ".tgz", ".tar", ".zip"] as const;

// ACCEPT_ATTR is the `accept` attribute for the file <input>.
export const ACCEPT_ATTR = KNOWN_EXTS.join(",");

// ACCEPT_RE is the client-side filename guard, mirroring KNOWN_EXTS.
export const ACCEPT_RE = /\.(tar\.gz|tgz|tar|zip)$/i;

// archiveExt is the recognised archive extension for a filename, or null.
export function archiveExt(filename: string): string | null {
  const lower = filename.toLowerCase();
  return KNOWN_EXTS.find((ext) => lower.endsWith(ext)) ?? null;
}
